import assert from "node:assert/strict";
import { mkdir, access, readFile, writeFile, symlink, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import net from "node:net";
import http from "node:http";
import https from "node:https";

let attempts = 0;
let mayListen = false;
const servers = new Set();
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  assert.ok(mayListen);
  assert.ok(["127.0.0.1", "::1"].includes(args[0]?.host));
  servers.add(this); return listen.apply(this, args);
};
const deny = () => { attempts++; throw Error("unexpected network/provider call"); };
globalThis.fetch = deny;
net.Socket.prototype.connect = deny;
http.request = http.get = https.request = https.get = deny;
syncBuiltinESMExports();
const { createDurableAgent, mockTextModel, mockChannel, AgentAdkError } = await import("@xpell/agent/adk");
const { _x, _xai, XNode } = await import("@xpell/node");
const root = await import("@xpell/agent");
assert.equal("createDurableAgent" in root, false);
const providers = await _xai._list_providers();
const require = createRequire(import.meta.url);
const agentRoot = dirname(require.resolve("@xpell/agent/package.json"));
const nodeRoot = dirname(require.resolve("@xpell/node/package.json"));
const { SQLiteEntityProvider } = await import(pathToFileURL(join(nodeRoot, "dist/XEntityManager/SQLiteEntityProvider.js")));
const { ConversationRepository } = await import(pathToFileURL(join(agentRoot, "dist/adk/starter/persistence/ConversationRepository.js")));
const { ConversationService } = await import(pathToFileURL(join(agentRoot, "dist/adk/starter/conversation/ConversationService.js")));
let disposed = 0;
const dispose = SQLiteEntityProvider.prototype.dispose;
SQLiteEntityProvider.prototype.dispose = async function (...a) { disposed++; return dispose.apply(this, a); };
const [scenario, parent] = process.argv.slice(2);
const folder = join(parent, "runtime");
const scope = { _env: "test", _app_id: "synthetic-app" };
const options = () => ({
  _name: "durable-fixture", _model: mockTextModel({ _text: "stored answer" }), _channel: mockChannel({ _id: "local" }),
  _host: { _work_folder: folder, _listen: { _host: "127.0.0.1", _port: 0 } },
  _conversations: { _provider: "sqlite", _instance_id: "fixture-instance", _application_scope: scope,
    _history_limit: 200, _context: { _max_context_tokens: 512, _reserved_output_tokens: 64,
      _safety_margin_tokens: 32, _system_instructions: "Respond to synthetic local fixtures." } },
});
const fixture = { _text: "persist me", _external_message_id: "stable-inbound" };
const repository = () => new ConversationRepository({ _application_scope: scope });
const snapshot = async (dir) => {
  const files = {};
  async function walk(d, prefix = "") {
    for (const name of (await readdir(d)).sort()) {
      const p = join(d, name), key = join(prefix, name);
      if ((await stat(p)).isDirectory()) await walk(p, key);
      else files[key] = createHash("sha256").update(await readFile(p)).digest("hex");
    }
  }
  await walk(dir); return files;
};
const stats = async (repo) => {
  const counts = {};
  for (const entity of ["conversation", "message"]) {
    const r = await _x.execute({ _module: "entity-manager", _op: "find", _params: {
      _app_id: "xpell-agent-starter", _env: "default", _entity_id: entity,
      _filter: { _application_scope_key: repo.applicationScopeKey }, _skip: 0, _limit: 0,
    } });
    assert.equal(r._ok, true); counts[entity === "message" ? "messages" : "conversations"] = r._result._records._meta._total_records;
  }
  return counts;
};
let app, foreign, blocker;
try {
  if (scenario === "config") {
    for (const change of [
      o => { delete o._conversations; }, o => { o._conversations._provider = "memory"; },
      o => { o._conversations._history_limit = 201; }, o => { o._conversations._history_limit = 0; },
      o => { o._conversations._instance_id = ""; }, o => { o._conversations._application_scope._app_id = "../bad"; },
      o => { o._conversations._context._max_context_tokens = 0; },
      o => { o._conversations._context._reserved_output_tokens = 512; },
      o => { o._conversations._context._safety_margin_tokens = -1; },
      o => { o._conversations._context._system_instructions = ""; },
      o => { o._conversations._context._application_context = "unapproved"; },
      o => { delete o._channel; }, o => { o._host._listen._host = "0.0.0.0"; },
    ]) {
      const o = structuredClone(options()); change(o); assert.throws(() => createDurableAgent(o));
    }
    await assert.rejects(access(folder), { code: "ENOENT" });
    assert.equal(servers.size, 0);
  } else if (["unknown-folder", "symlink", "mismatch"].includes(scenario)) {
    let before;
    if (scenario === "unknown-folder") { await mkdir(folder); await writeFile(join(folder, "sentinel"), "synthetic preserve"); before = await snapshot(folder); }
    if (scenario === "symlink") { await mkdir(join(parent, "target")); await symlink(join(parent, "target"), folder); }
    const o = options();
    if (scenario === "mismatch") { before = await snapshot(folder); o._conversations._application_scope = { _env: "test", _app_id: "other-app" }; }
    app = createDurableAgent(o);
    await assert.rejects(app.start(), { _code: "E_ADK_PROFILE_MISMATCH" });
    if (before) assert.deepEqual(await snapshot(folder), before);
    assert.equal(disposed, 0); assert.equal(servers.size, 0);
  } else if (scenario === "close-before-start") {
    app = createDurableAgent(options()); await app.close(); await app.close();
    await assert.rejects(app.start(), { _code: "E_ADK_CLOSED" });
    await assert.rejects(access(folder), { code: "ENOENT" });
  } else if (scenario === "foreign-host") {
    mayListen = true; foreign = new XNode();
    await foreign.start({ _work_folder: join(parent, "foreign"), _host: "127.0.0.1", _port: 0,
      _web_settings: { "enable-wormhole": false, "enable-ssl": false } });
    app = createDurableAgent(options());
    await assert.rejects(app.start(), { _code: "E_ADK_HOST_IN_USE" }); await app.close();
    assert.equal(_x.isRunning(), true); assert.equal(disposed, 0);
    assert.equal(foreign._web_server._web_server.listening, true);
    await assert.rejects(access(folder), { code: "ENOENT" });
  } else {
    const o = options(); mayListen = true;
    if (scenario === "other-scope") { o._host._work_folder = join(parent, "other"); o._conversations._application_scope = { _env: "test", _app_id: "other-app" }; }
    if (scenario === "read") o._model = mockTextModel({ _text: "must not replace durable reply" });
    if (scenario === "bounds") o._conversations._history_limit = 3;
    if (scenario === "failed-listen") {
      blocker = net.createServer(); await new Promise(r => blocker.listen({ host: "127.0.0.1", port: 0 }, r));
      o._host._listen._port = blocker.address().port;
    }
    if (scenario === "partial-start") {
      const start = XNode.prototype.start;
      XNode.prototype.start = async function (opts) { await start.call(this, opts); await this.stop(); throw Error("synthetic partial-start failure after registration"); };
    }
    app = createDurableAgent(o);
    await assert.rejects(app.getHistory(), { _code: "E_ADK_NOT_READY" });
    assert.equal(servers.size, scenario === "failed-listen" ? 1 : 0);
    if (scenario === "close-during-start") {
      const p = assert.rejects(app.start(), { _code: "E_ADK_CLOSED" }); await app.close(); await p;
    } else if (["failed-listen", "partial-start"].includes(scenario)) {
      await assert.rejects(app.start(), scenario === "failed-listen" ? { code: "EADDRINUSE" } : /partial-start/);
      await app.close(); assert.equal(_x.isRunning(), false);
      if (scenario === "partial-start") assert.equal(disposed, 4, "close application-owned providers after Core fencing");
    } else {
      await app.start(); const repo = repository();
      if (scenario === "crash") {
        const execute = _x.execute;
        _x.execute = async function (cmd) {
          const result = await execute.call(this, cmd);
          if (cmd._module === "entity-manager" && cmd._op === "update" && cmd._params?._updates?._delivery_state === "sending") {
            assert.equal(result._ok, true); console.log("CRASH_AFTER_DURABLE_SENDING"); process.kill(process.pid, "SIGKILL");
          }
          return result;
        };
        await app.testTurn(fixture); assert.fail("crash hook did not run");
      } else if (scenario === "recover") {
        const inbound = await repo.findMessageByDedupeKey(repo.inboundDedupeKey("local", "mock-conversation", "stable-inbound"));
        const outbound = await repo.findMessageByDedupeKey(repo.outboundDedupeKey("local", "mock-conversation", inbound._id));
        assert.equal(outbound._delivery_state, "uncertain");
        const before = await stats(repo);
        await assert.rejects(app.testTurn(fixture), { _code: "E_ADK_REPLAY_UNCERTAIN" });
        assert.deepEqual(await stats(repo), before);
        assert.equal((await app.getHistory())._messages.some(m => m._role === "assistant"), false);
      } else if (scenario === "drain") {
        let release, entered;
        const gate = new Promise(r => { release = r; }); const reached = new Promise(r => { entered = r; });
        const execute = _x.execute;
        _x.execute = async function (cmd) {
          if (cmd._module === "durable-fixture" && cmd._op === "receive-message") { entered(); await gate; }
          return execute.call(this, cmd);
        };
        const turn = app.testTurn(fixture); await reached; const closing = app.close();
        await assert.rejects(app.testTurn(fixture), { _code: "E_ADK_NOT_READY" });
        release(); assert.equal(await turn, "stored answer"); await closing;
        _x.execute = execute; assert.equal(disposed, 4);
      } else {
        const sent = [];
        const execute = _x.execute;
        _x.execute = async function (cmd) { if (cmd._module === "durable-fixture") sent.push(cmd); return execute.call(this, cmd); };
        if (scenario === "read") {
          const saved = JSON.parse(await readFile(join(parent, "expected.json"), "utf8"));
          assert.deepEqual(await app.getHistory(), saved);
          const before = await stats(repo);
          assert.equal(await app.testTurn(fixture), "stored answer");
          assert.deepEqual(await stats(repo), before); assert.deepEqual(await app.getHistory(), saved);
          const context = await app.getContext({ _current_text: "read-only preview" });
          assert.deepEqual(new Set(context._history_message_ids), new Set(saved._messages.map(m => m._id)));
          assert.deepEqual(await stats(repo), before);
          await assert.rejects(app.testTurn({ ...fixture, _text: "changed payload" }), AgentAdkError);
          await assert.rejects(app.testTurn({ ...fixture, _external_user_id: "different-sender" }), AgentAdkError);
          assert.deepEqual(await stats(repo), before);
        } else {
          assert.equal(await app.testTurn(fixture), "stored answer");
          const first = await app.getHistory(); assert.equal(first._messages.length, 2);
          if (["write", "other-scope"].includes(scenario)) {
            if (scenario === "write") await writeFile(join(parent, "expected.json"), JSON.stringify(first));
            else assert.notEqual(first._conversation_id, JSON.parse(await readFile(join(parent, "expected.json"), "utf8"))._conversation_id);
          }
          if (scenario === "isolation") {
            const before = await stats(repo);
            assert.deepEqual(await Promise.all([app.testTurn(fixture), app.testTurn(fixture)]), ["stored answer", "stored answer"]);
            assert.deepEqual(await stats(repo), before);
            await app.testTurn({ ...fixture, _text: "other conversation", _external_conversation_id: "other" });
            const other = await app.getHistory({ _external_conversation_id: "other" });
            assert.notEqual(first._conversation_id, other._conversation_id);
            assert.equal(other._messages.length, 2); assert.deepEqual(await app.getHistory(), first);
            await assert.rejects(app.getHistory({ _external_user_id: "unknown" }), { _code: "E_ADK_CONVERSATION_NOT_FOUND" });
          }
          if (scenario === "bounds") {
            for (let i = 0; i < 18; i++) await app.testTurn({ _text: `synthetic history ${i} ${"x".repeat(60)}` });
            assert.equal((await app.getHistory())._messages.length, 3);
            const context = await app.getContext({ _current_text: "current" });
            assert.ok(context._history_message_ids.length < 38);
            assert.ok(context._estimated_input_tokens <= context._input_budget_tokens);
            assert.equal(context._messages.at(-1)._content[0]._text, "current");
            const before = await stats(repo);
            await assert.rejects(app.getContext({ _current_text: "x".repeat(3000) }), { _code: "E_STARTER_CONTEXT_BUDGET_EXCEEDED" });
            await assert.rejects(app.testTurn({ _text: "x".repeat(3000), _external_message_id: "over-budget" }), AgentAdkError);
            assert.equal((await app.getHistory())._messages.some(m => m._text.length === 3000), false);
            assert.equal((await stats(repo)).messages, before.messages + 1);
          }
          if (scenario === "filtered-history") {
            const records = await repo.listRecentMessageHistory({ _conversation_id: first._conversation_id, _limit: 10 });
            const answer = records.find(m => m._direction === "outbound");
            for (const state of ["pending", "sending", "uncertain", "failed"]) {
              await repo.updateMessage(answer._id, { _delivery_state: state });
              assert.equal((await app.getHistory())._messages.length, 1);
              assert.equal((await app.getContext({ _current_text: "preview" }))._history_message_ids.includes(answer._id), false);
            }
            await repo.updateMessage(answer._id, { _delivery_state: "accepted", _text: "<think>private synthetic planning" });
            assert.match((await app.getHistory())._messages.find(m => m._role === "assistant")._text, /withheld/);
            const ctx = await app.getContext({ _current_text: "preview" });
            assert.equal(ctx._history_message_ids.includes(answer._id), false);
            assert.equal(JSON.stringify(ctx).includes("private synthetic planning"), false);
            assert.equal(JSON.stringify(ctx._context).includes("_participant_id"), false);
            // Same physical fixture DB, separate logical scope: no record visibility.
            const other = new ConversationRepository({ _application_scope: { _env: "test", _app_id: "other-app" } });
            assert.equal(await other.findConversation({ _source_type: "channel", _source_id: "local", _source_conversation_id: "mock-conversation" }), null);
            const service = new ConversationService({ _repository: other });
            assert.throws(() => service.assertConversationScope({ _application_scope_key: repo.applicationScopeKey }));
          }
        }
        _x.execute = execute;
      }
      await app.close(); await app.close();
      assert.equal(disposed, 4, "all four application SQLite handles must close once");
      await assert.rejects(app.getHistory(), { _code: "E_ADK_NOT_READY" });
    }
  }
} finally {
  await app?.close(); await foreign?.stop();
  if (blocker) await new Promise(r => blocker.close(r));
}
assert.equal(attempts, 0);
assert.ok([...servers].every(s => !s.listening));
assert.deepEqual(await _xai._list_providers(), providers);
console.log("CONVERSATIONS_PASS", scenario);
