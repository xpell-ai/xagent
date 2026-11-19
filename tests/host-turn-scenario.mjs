import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";

let allowed = false, network = 0, starts = 0, stops = 0, accepted = 0, receives = 0, getters = 0;
const servers = new Set(), listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  assert.ok(allowed); assert.equal(args[0]?.host, "127.0.0.1"); assert.equal(args[0]?.port, 0);
  servers.add(this); return listen.apply(this, args);
};
const deny = () => { network++; throw Error("E_OFFLINE_ONLY"); };
globalThis.fetch = deny; net.Socket.prototype.connect = deny;
http.get = http.request = https.get = https.request = deny; dgram.Socket.prototype.send = deny;
const lookup = dns.lookup; dns.lookup = (host, ...args) => host === "127.0.0.1" ? lookup(host, ...args) : deny();
syncBuiltinESMExports();

const { createAgentHost, AgentHostError } = await import("@xpell/agent/adk/host");
const { createAgent, mockChannel, mockTextModel } = await import("@xpell/agent/adk");
const { syntheticBusinessTurn } = await import("../examples/host-turn-agent.mjs");
const { _x, _xai, XNode } = await import("@xpell/node");
const providers = await _xai._list_providers(), events = [];
const start = XNode.prototype.start, stop = XNode.prototype.stop, execute = _x.execute;
XNode.prototype.start = function (...args) { starts++; return start.apply(this, args); };
XNode.prototype.stop = function (...args) { stops++; return stop.apply(this, args); };
let captured, duplicate;
_x.execute = async function (command) {
  const inbound = command._module === "delegated-host" && command._op === "receive-message";
  if (inbound) { receives++; captured = structuredClone(command); events.push("native.receive-message"); }
  const response = await execute.call(this, command);
  if (inbound && response?._ok && response._result?._accepted) { accepted++; events.push("Channel.accepted"); }
  return response;
};
const parent = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "adk-host-turn-")));
const mode = process.argv[2], question = "What are the opening hours for synthetic-business-001?";
const control = { reads: true, run: true, reply: true };
const record = (event) => {
  events.push(event);
  if (mode === "revoke-invoke" && event === "model.tool-call") control.reads = false;
  if (mode === "revoke-reply" && event === "model.grounded-answer") control.reads = false;
  if (mode === "revoke-host" && event === "model.grounded-answer") control.run = false;
  if (mode === "duplicate-ingress" && event === "model.tool-call" && !duplicate) duplicate = _x.execute(structuredClone(captured));
};
const sample = syntheticBusinessTurn({ record, control, hours: mode === "hours-b" ? "11:30-15:45 Tuesday-Saturday" : undefined,
  actor: mode === "actor" ? "fixture-denied" : undefined,
  mode: ["arguments", "batch", "unknown", "forged"].includes(mode) ? mode : "normal" });
const profile = (folder = "work") => ({ _name: "delegated-host", _model: mockTextModel({ _text: "UNUSED_MOCK_FALLBACK" }),
  _channel: mockChannel({ _id: "local" }), _plugins: [],
  _host: { _work_folder: join(parent, folder), _listen: { _host: "127.0.0.1", _port: 0 } } });
const config = () => ({ _profile: { _type: "foundation", _options: profile() }, _turn: sample.delegate });
const reject = (work, code) => assert.rejects(work, error => {
  assert.ok(error instanceof AgentHostError); assert.equal(error._code, code);
  assert.ok(!error.message.includes("RAW_FAILURE")); assert.ok(!JSON.stringify(error).includes(parent)); return true;
});
const gate = () => { let release, entered; const wait = new Promise(r => release = r), reached = new Promise(r => entered = r); return { release, entered, wait, reached }; };
let host, other, foreign, held, answer;
try {
  let options = config();
  if (mode === "legacy") delete options._turn;
  if (mode === "config") {
    const bad = [
      { ...sample.delegate, _authorize: undefined }, { ...sample.delegate, _extra: true },
      { ...sample.delegate, _limits: { ...sample.delegate._limits, _timeout_ms: 5001 } },
      { ...sample.delegate, _limits: { ...sample.delegate._limits, _max_input_bytes: 0 } },
      { ...sample.delegate, get _run() { getters++; return sample.delegate._run; } },
      new Proxy(sample.delegate, { ownKeys() { getters++; throw Error("RAW_FAILURE"); } }),
    ];
    for (const _turn of bad) assert.throws(() => createAgentHost({ ...options, _turn }), { _code: "E_ADK_HOST_CONFIG" });
    assert.throws(() => createAgent({ ...profile(), _turn: sample.delegate }), { _code: "E_ADK_CONFIG" });
    assert.equal(getters, 0); assert.equal(starts, 0); await assert.rejects(fs.access(join(parent, "work")), { code: "ENOENT" });
  } else {
    if (["snapshot", "input-limit", "output-limit", "output-type", "raw-error", "getter-error", "proxy-error", "unsafe-code"].includes(mode)) {
      const custom = { _run: async () => "snapshot reply", _authorize: () => true,
        _limits: { _timeout_ms: 1000, _max_input_bytes: 128, _max_output_bytes: 32 } };
      if (mode === "output-limit") custom._run = async () => "x".repeat(33);
      if (mode === "output-type") custom._run = async () => ({ get toString() { getters++; return () => "RAW_FAILURE"; } });
      if (mode === "raw-error") custom._run = async () => { throw Error("RAW_FAILURE private details"); };
      if (mode === "getter-error") custom._run = async () => { throw { get _code() { getters++; return "RAW_FAILURE"; } }; };
      if (mode === "proxy-error") custom._run = async () => { throw new Proxy({}, { getPrototypeOf() { getters++; throw Error("RAW_FAILURE"); } }); };
      if (mode === "unsafe-code") custom._run = async () => { throw new AgentHostError("RAW_FAILURE"); };
      options._turn = custom;
    }
    if (["timeout", "cancel", "close-active", "cancel-run-policy", "cancel-reply-policy"].includes(mode)) {
      held = gate();
      options._turn = { _limits: { _timeout_ms: mode === "timeout" ? 30 : 1000, _max_input_bytes: 128, _max_output_bytes: 128 },
        _authorize: async req => {
          if ((mode === "cancel-run-policy" && req._phase === "run") || (mode === "cancel-reply-policy" && req._phase === "reply")) {
            held.entered(); await held.wait;
          }
          return true;
        },
        _run: async () => {
          events.push("controlled.run");
          if (!["cancel-run-policy", "cancel-reply-policy"].includes(mode)) { held.entered(); await held.wait; }
          return "late controlled reply";
        } };
    }
    if (mode === "run-denied") control.run = false;
    if (mode === "reply-denied") control.reply = false;
    if (mode === "read-denied") control.reads = false;
    if (mode === "view" || mode === "hours-a") {
      const source = join(parent, "source"); await fs.cp(new URL("./fixtures/host-view", import.meta.url), source, { recursive: true });
      const hash = createHash("sha256");
      for (const rel of ["app.json", "views/view-main.json"]) { const b = await fs.readFile(join(source, rel)); hash.update(rel + "\0" + b.length + "\0").update(b); }
      options._system_apps = [{ _env: "default", _app_id: "sample-host", _source_dir: source, _sha256: hash.digest("hex") }];
    }
    host = createAgentHost(options);
    if (mode === "snapshot") { options._turn._run = async () => "RAW_FAILURE"; options._turn._authorize = () => false; options._turn._limits._max_output_bytes = 1; }
    assert.equal(starts, 0); assert.equal(events.length, 0); allowed = true;
    if (mode === "foreign") {
      foreign = new XNode(); await foreign.start({ _work_folder: join(parent, "foreign"), _host: "127.0.0.1", _port: 0,
        _web_settings: { "enable-wormhole": false, "enable-ssl": false } });
      await reject(host.start(), "E_ADK_HOST_IN_USE"); await host.close(); assert.equal(starts, 1); assert.equal(stops, 0); assert.ok(_x.isRunning());
      await foreign.stop(); foreign = undefined;
    } else if (mode === "close-before") {
      await host.close(); await reject(host.start(), "E_ADK_CLOSED"); assert.equal(starts, 0);
    } else {
      await reject(host.testTurn({ _text: question }), "E_ADK_NOT_READY");
      const starting = host.start(); assert.equal(host.start(), starting); await starting;
      assert.equal(starts, 1); assert.equal(host.getStatus()._state, "ready");
      if (mode === "competing") {
        other = createAgentHost({ ...config(), _profile: { _type: "foundation", _options: profile("other") } });
        await reject(other.start(), "E_ADK_HOST_IN_USE"); await other.close(); assert.ok(_x.isRunning()); assert.equal(stops, 0);
      }
      if (mode === "input-limit") {
        await reject(host.testTurn({ _text: "é".repeat(65) }), "E_ADK_HOST_TURN_LIMIT"); assert.equal(receives, 0);
      } else if (mode === "signal") {
        await reject(host.testTurn({ _text: question }, new Proxy({}, { getPrototypeOf() { getters++; throw Error("RAW_FAILURE"); } })), "E_ADK_HOST_CONFIG");
        const aborted = new AbortController(); aborted.abort(); await reject(host.testTurn({ _text: question }, aborted.signal), "E_ADK_HOST_TURN_CANCELLED");
        assert.equal(receives, 0); assert.equal(getters, 0);
        const signal = new AbortController().signal;
        Object.defineProperty(signal, "aborted", { get() { getters++; throw Error("RAW_FAILURE"); } });
        Object.defineProperty(signal, "addEventListener", { get() { getters++; throw Error("RAW_FAILURE"); } });
        Object.defineProperty(signal, "removeEventListener", { get() { getters++; throw Error("RAW_FAILURE"); } });
        assert.match(await host.testTurn({ _text: question }, signal), /Synthetic Corner Shop/);assert.equal(getters, 0);
      } else if (mode === "input") {
        await reject(host.testTurn({ get _text() { getters++; return question; } }), "E_ADK_HOST_CONFIG");
        await reject(host.testTurn({ _text: question, _actor_id: "admin" }), "E_ADK_HOST_CONFIG");assert.equal(getters, 0);assert.equal(receives, 0);
      } else if (held) {
        const abort = new AbortController(), pending = host.testTurn({ _text: question }, abort.signal);
        const rejection = reject(pending, mode === "timeout" ? "E_ADK_HOST_TURN_TIMEOUT" : "E_ADK_HOST_TURN_CANCELLED");
        await held.reached;
        if (mode === "close-active") host.close(); else if (mode !== "timeout") abort.abort();
        await rejection;
        if (mode !== "close-active") await reject(host.testTurn({ _text: question }), "E_ADK_HOST_TURN_BUSY");
        let finished = false; const closing = host.close().then(() => { finished = true; });
        await Promise.resolve(); await Promise.resolve(); assert.equal(finished, false); assert.equal(stops, 0); assert.equal(accepted, 0);
        held.release(); await closing; assert.equal(stops, 1); assert.equal(accepted, 0);
        if (mode === "cancel-run-policy") assert.ok(!events.includes("controlled.run"));
      } else if (["output-limit", "output-type", "raw-error", "getter-error", "proxy-error", "unsafe-code"].includes(mode)) {
        await reject(host.testTurn({ _text: question }), mode.startsWith("output") ? "E_ADK_HOST_TURN_LIMIT" : "E_ADK_HOST_TURN_FAILED");
        assert.equal(accepted, 0); assert.equal(getters, 0);
      } else if (["run-denied", "reply-denied", "read-denied", "actor", "forged", "revoke-invoke", "revoke-reply", "revoke-host", "arguments", "batch", "unknown"].includes(mode)) {
        await reject(host.testTurn({ _text: question }), ["arguments", "batch", "unknown"].includes(mode) ? "E_ADK_HOST_TURN_FAILED" : "E_ADK_HOST_TURN_DENIED");
        assert.equal(accepted, 0);
        if (["run-denied", "actor"].includes(mode)) { assert.equal(sample.getEvidence().handlers, 0); assert.equal(sample.getEvidence().rounds, 0); }
        if (["arguments", "batch", "unknown", "forged", "read-denied", "revoke-invoke"].includes(mode)) assert.equal(sample.getEvidence().handlers, 0);
      } else {
        if (mode === "rogue") {
          const bad = await _x.execute({ _module: "delegated-host", _op: "receive-message", _params: { _channel_id: "local", _external_user_id: "mock-participant",
            _external_conversation_id: "mock-conversation", _external_message_id: "forged", _text: question } });
          assert.equal(bad._ok, false); assert.equal(sample.getEvidence().rounds, 0);
        }
        answer = await host.testTurn({ _text: question });
        if (mode === "legacy") { assert.equal(answer, "UNUSED_MOCK_FALLBACK"); assert.equal(sample.getEvidence().handlers, 0); }
        else if (mode === "snapshot") assert.equal(answer, "snapshot reply");
        else {
          const expected = mode === "hours-b" ? "11:30-15:45 Tuesday-Saturday" : "09:00-17:00 Monday-Friday";
          assert.equal(answer, `Synthetic Corner Shop is open ${expected} (UTC).`); assert.equal(sample.getEvidence().handlers, 1);
          const order = ["native.receive-message", "host.authorize.run", "model.tool-call", "application.registry-invoke", "T1.handler", "application.tool-result", "model.grounded-answer", "host.authorize.reply", "Channel.accepted"];
          const indexes = order.map(e => events.indexOf(e)); assert.ok(indexes.every(n => n >= 0)); assert.deepEqual([...indexes].sort((a,b)=>a-b), indexes);
          assert.ok(!JSON.stringify(sample.getEvidence().model_inputs[0]).includes(expected));
          assert.ok(!JSON.stringify(sample.getEvidence().model_inputs[0]).includes("Synthetic Corner Shop"));
        }
        if (mode === "duplicate-ingress") { assert.equal((await duplicate)._ok, false); assert.equal(accepted, 1); }
        if (mode === "replay") {
          assert.equal(await host.testTurn({ _text: question }), answer); assert.equal(sample.getEvidence().handlers, 1); assert.equal(sample.getEvidence().rounds, 4);
          control.reads = false; await reject(host.testTurn({ _text: question }), "E_ADK_HOST_TURN_DENIED"); assert.equal(accepted, 2); assert.equal(sample.getEvidence().handlers, 1);
        }
        if (mode === "conflict") { await reject(host.testTurn({ _text: question.replace("001", "002") }), "E_ADK_HOST_TURN_FAILED");assert.equal(sample.getEvidence().handlers, 1);assert.equal(accepted, 1); }
        if (options._system_apps) {
          const scope = { _env: "default", _app_id: "sample-host" }, expected = { _id: "view-main", _type: "view", _children: [] };
          const view = await _x.execute({ _module: "server-xvm", _op: "get-view", _params: { ...scope, _view_id: "view-main" } });
          assert.deepEqual(view._result._view, expected);
          await assert.rejects(_x.execute({ _module: "server-xvm", _op: "push-update", _params: { ...scope, _view: expected } }), { _code: "E_XVM_READONLY" });
          const again = await _x.execute({ _module: "server-xvm", _op: "get-view", _params: { ...scope, _view_id: "view-main" } });assert.deepEqual(again._result._view, expected);
        }
      }
      await host.close(); assert.equal(host.getStatus()._state, "closed"); assert.equal(stops, 1);
      await reject(host.testTurn({ _text: question }), "E_ADK_NOT_READY"); await reject(host.start(), "E_ADK_CLOSED");
    }
  }
  assert.equal(network, 0); assert.ok([...servers].every(s => !s.listening)); assert.equal(_x.isRunning(), false);
  assert.deepEqual(await _xai._list_providers(), providers);
  console.log("HOST_TURN_PASS", JSON.stringify({ mode, answer, events, accepted, receives, starts, stops, network,
    evidence: sample.getEvidence(), view_contains_business_data: false }));
} finally {
  held?.release(); await other?.close(); await host?.close(); await foreign?.stop(); sample.close();
  XNode.prototype.start = start; XNode.prototype.stop = stop; _x.execute = execute;
  await fs.rm(parent, { recursive: true, force: true });
}
