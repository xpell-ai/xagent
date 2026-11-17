import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import net from "node:net";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import dgram from "node:dgram";
let denied = 0;
const deny = () => { denied++; throw Error("external network blocked"); };
const local = h => ["127.0.0.1", "::1", "[::1]"].includes(h);
const fetch = globalThis.fetch;
globalThis.fetch = (url, ...args) => local(new URL(url).hostname) ? fetch(url, ...args) : deny();
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const host = args[0]?.host ?? (typeof args[1] === "string" ? args[1] : "127.0.0.1");
  if (!local(host)) return deny(); return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (h, ...args) { if (!local(h)) return deny(); return lookup.call(this, h, ...args); };
for (const api of [http, https]) for (const method of ["request", "get"]) api[method] = deny;
tls.connect = deny; dgram.createSocket = deny;
syncBuiltinESMExports();
const require = createRequire(import.meta.url);
const root = dirname(require.resolve("@xpell/agent/package.json"));
const { startOfflineRouter, OFFLINE_ROUTER_KEY } = await import(pathToFileURL(join(root, "examples/offline-router.mjs")));
const { createRouterAgent, routerTextModel, mockChannel } = await import("@xpell/agent/adk");
const { _x, _xai } = await import("@xpell/node");
const { AimeProvider } = await import("@xpell/xai-providers/aime");
const [scenario, parent] = process.argv.slice(2);
const folder = join(parent, "runtime");
process.env.XAGENT_TEST_ROUTER_KEY = scenario === "wrong-key" ? "wrong-synthetic-key" : OFFLINE_ROUTER_KEY;
const fixture = await startOfflineRouter({ _port: 0, _mode: scenario });
const options = () => ({ _name: "router-test", _model: routerTextModel({ _endpoint: fixture.endpoint,
  _model: "fixture-chat", _credential: { _env: "XAGENT_TEST_ROUTER_KEY" }, _timeout_ms: scenario === "timeout" ? 150 : 5000,
  _error_policy: "fail-closed", _allow_requests: true }), _channel: mockChannel({ _id: "local" }),
  _host: { _work_folder: folder, _listen: { _host: "127.0.0.1", _port: 0 } },
  _conversations: { _provider: "sqlite", _instance_id: "router-test-instance",
    _application_scope: { _env: "test", _app_id: "router-test-app" }, _history_limit: 100,
    _context: { _max_context_tokens: 700, _reserved_output_tokens: 100, _safety_margin_tokens: 50, _system_instructions: "Synthetic chat policy." } } });
const input = { _text: "first synthetic turn", _external_message_id: "in-1" };
let app, blocker;
let foreignCalls = 0;
const foreign = { _provider_id: "foreign", generate: async () => { foreignCalls++; throw Error("foreign fallback forbidden"); } };
_xai.registerProvider("foreign-test", foreign);
try {
  if (scenario === "cli-gate") {
    const child = spawnSync(process.execPath, [join(root, "examples/router-chat.mjs"), "--approved-router",
      join(parent, "not-read.json"), "delivery", "synthetic"], { encoding: "utf8", timeout: 5000,
      env: { PATH: process.env.PATH, LANG: "C", NODE_ENV: "test" } });
    assert.equal(child.status, 1); assert.match(child.stderr, /E_ADK_ROUTER_OWNER_APPROVAL_REQUIRED/);
    assert.equal(fixture.requests.length, 0); await assert.rejects(access(folder), { code: "ENOENT" });
  } else if (scenario === "config") {
    const clean = options()._model; const { _type, ...base } = clean;
    for (const change of [
      v => { v._endpoint = "http://example.invalid"; }, v => { v._endpoint = "https://example.invalid/path"; },
      v => { v._endpoint = "http://user:secret@127.0.0.1"; }, v => { v._endpoint += "?key=secret"; },
      v => { v._timeout_ms = 0; }, v => { v._timeout_ms = 120001; }, v => { v._allow_requests = false; },
      v => { v._credential = { _value: "forbidden" }; }, v => { v._error_policy = "retry"; },
      v => { v._credential._env = "bad name"; }, v => { v._model = ""; },
    ]) { const v = structuredClone(base); change(v); assert.throws(() => routerTextModel(v)); }
    await assert.rejects(access(folder), { code: "ENOENT" }); assert.equal(fixture.requests.length, 0);
  } else if (scenario === "auth-omission") {
    const provider = new AimeProvider({ endpoint: fixture.endpoint, apiKey: "", timeoutMs: 1000 });
    await assert.rejects(provider.generate({ prompt: "synthetic" }), /Missing Aime API key/);
    assert.equal(fixture.requests.length, 0);
    const result = await (await globalThis.fetch(fixture.endpoint + "/wh/v2/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      _v: 2, _kind: "REQ", _id: "missing-auth", _payload: { _module: "xai-router", _op: "generate", _params: {} } }) })).json();
    assert.equal(result._payload._result._error._code, "E_XAI_API_KEY_REQUIRED"); assert.equal(fixture.generations, 0);
  } else {
    const o = options();
    if (scenario === "credential") delete process.env.XAGENT_TEST_ROUTER_KEY;
    if (scenario === "failed-start") {
      blocker = net.createServer(); await new Promise(r => blocker.listen({ host: "127.0.0.1", port: 0 }, r));
      o._host._listen._port = blocker.address().port;
    }
    app = createRouterAgent(o);
    o._model = { ...o._model, _endpoint: "https://forbidden.invalid" }; // Construction snapshots config.
    assert.equal(_x.isRunning(), false); assert.equal(fixture.requests.length, 0);
    await assert.rejects(app.chat(input), { _code: "E_ADK_NOT_READY" });
    if (["credential", "failed-start"].includes(scenario)) {
      await assert.rejects(app.start(), scenario === "credential" ? { _code: "E_ADK_ROUTER_CREDENTIAL" } : { code: "EADDRINUSE" });
      if (scenario === "credential") await assert.rejects(access(folder), { code: "ENOENT" });
      assert.deepEqual((await _xai._list_providers())._providers, ["foreign-test"]);
    } else {
      await app.start(); assert.equal(fixture.requests.length, 0, "start performs no probe/call");
      assert.equal(_xai.getDefaultProvider(), foreign);
      const registered = (await _xai._list_providers())._providers.filter(id => id !== "foreign-test"); assert.equal(registered.length, 1);
      if (scenario === "drain") {
        let release, entered;
        const gate = new Promise(r => { release = r; }); const reached = new Promise(r => { entered = r; });
        const execute = _x.execute;
        _x.execute = async function (cmd) { if (cmd._module === "xai") { entered(); await gate; } return execute.call(this, cmd); };
        const turn = app.chat(input); await reached; const closing = app.close();
        await assert.rejects(app.chat(input), { _code: "E_ADK_NOT_READY" }); release();
        assert.equal(await turn, "Offline Router: first synthetic turn"); await closing; _x.execute = execute;
      } else if (["write", "read", "context"].includes(scenario)) {
        if (scenario === "read") {
          const expected = JSON.parse(await readFile(join(parent, "expected.json"), "utf8"));
          assert.deepEqual(await app.getHistory(), expected);
          assert.equal(await app.chat(input), "Offline Router: first synthetic turn"); assert.equal(fixture.requests.length, 0);
          const ctx = await app.getContext({ _current_text: "preview" }); assert.equal(ctx._history_message_ids.length, 2);
          await app.chat({ _text: "after restart", _external_message_id: "in-2" });
          assert.equal(fixture.requests.length, 1);
          assert.ok(fixture.requests[0].request._payload._params._messages.some(m => m._role === "assistant" && m._content[0]._text.includes("first synthetic")));
        } else {
          assert.equal(await app.chat(input), "Offline Router: first synthetic turn");
          assert.deepEqual(await Promise.all([app.chat(input), app.chat(input)]), ["Offline Router: first synthetic turn", "Offline Router: first synthetic turn"]);
          assert.equal(fixture.requests.length, 1); assert.equal(fixture.generations, 1);
          if (scenario === "write") await writeFile(join(parent, "expected.json"), JSON.stringify(await app.getHistory()));
          else {
            for (let i = 0; i < 8; i++) await app.chat({ _text: `bounded ${i} ${"x".repeat(80)}`, _external_message_id: `history-${i}` });
            const p = fixture.requests.at(-1).request._payload._params;
            assert.ok(p._messages.length < 17); assert.equal(p._messages.at(-1)._role, "user");
            const calls = fixture.requests.length;
            await app.chat({ _text: "different conversation", _external_conversation_id: "other", _external_message_id: "in-1" });
            const other = fixture.requests.at(-1).request._payload._params;
            assert.equal(other._messages.length, 1); assert.notEqual(other._idempotency_key, p._idempotency_key);
            await assert.rejects(app.chat({ _text: "x".repeat(4000) })); assert.equal(fixture.requests.length, calls + 1);
          }
        }
        for (const { request, headers } of fixture.requests) {
          const p = request._payload._params;
          assert.equal(headers.authorization, undefined); assert.equal(p._api_key, OFFLINE_ROUTER_KEY);
          assert.equal(p._model, "fixture-chat"); assert.equal(p._max_tokens, 100); assert.equal(p._system, "Synthetic chat policy.");
          assert.equal(p._app_id, "router-test-app"); assert.equal(p._env, "test"); assert.equal(p._purpose, "agent-chat");
          assert.match(p._idempotency_key, /^[a-f0-9]{64}$/);
          assert.equal(p._tools, undefined); assert.equal(p._provider, undefined);
          assert.equal(JSON.stringify([p._context,p._messages,p._system]).includes(OFFLINE_ROUTER_KEY), false);
          assert.equal(JSON.stringify(p._context).includes("_participant_id"), false);
          assert.equal(p._credit_balance, undefined); assert.equal(p._usage, undefined);
        }
      } else {
        const codes = { "wrong-key": "E_XAI_API_KEY_INVALID", "timeout": "E_ADK_ROUTER_TIMEOUT", "routing-error": "E_XAI_REQUESTED_MODEL_NOT_ALLOWED",
          "metering-error": "E_XAI_METERING_INCOMPLETE", "non-json": "E_ADK_ROUTER_TRANSPORT", "malformed": "E_ADK_ROUTER_TRANSPORT",
          "missing-result": "E_ADK_ROUTER_TRANSPORT", "planning": "E_ADK_ROUTER_RESULT", "truncated": "E_ADK_ROUTER_RESULT", "tools": "E_ADK_ROUTER_RESULT" };
        await assert.rejects(app.chat(input), { _code: codes[scenario] });
        assert.equal(fixture.requests.length, 1);
        await assert.rejects(app.chat(input), { _code: "E_ADK_REPLAY_UNCERTAIN" });
        assert.equal(fixture.requests.length, 1, "no automatic retry or replay after ambiguous/failed generation");
        assert.equal((await app.getHistory())._messages.some(m => m._role === "assistant"), false);
      }
      await app.close(); await app.close();
      await assert.rejects(_xai.getProvider(registered[0]).generate({ prompt: "after close" }), { _code: "E_ADK_CLOSED" });
      assert.equal(_xai.getDefaultProvider(), foreign); assert.equal(foreignCalls, 0);
      // Inspect only this test's own synthetic store, never an existing runtime.
      async function scan(dir) { for (const f of await readdir(dir)) { const p = join(dir, f); if ((await stat(p)).isDirectory()) await scan(p);
        else assert.equal((await readFile(p)).includes(Buffer.from(OFFLINE_ROUTER_KEY)), false, "credential must not persist"); } }
      await scan(folder);
    }
  }
} finally { try { await app?.close(); } finally { await fixture.close(); if (blocker) await new Promise(r => blocker.close(r)); delete process.env.XAGENT_TEST_ROUTER_KEY; } }
assert.equal(denied, 0); assert.equal(_x.isRunning(), false); assert.equal(foreignCalls, 0);
console.log("ROUTER_SCENARIO_PASS", scenario);
