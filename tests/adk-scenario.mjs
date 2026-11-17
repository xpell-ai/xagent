import assert from "node:assert/strict";
import { mkdtemp, rm, access, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

let mayListen = false;
let attempts = 0;
const servers = new Set();
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  assert.ok(mayListen, "import/construction must not open a listener");
  assert.ok(["127.0.0.1", "::1"].includes(args[0]?.host), "listener must be explicit loopback");
  servers.add(this);
  return listen.apply(this, args);
};
function denyNetwork() { attempts += 1; throw new Error("unexpected outbound network"); }
globalThis.fetch = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
http.request = http.get = https.request = https.get = denyNetwork;
syncBuiltinESMExports();

const root = await import("@xpell/agent");
const { createAgent, mockChannel, mockTextModel, AgentAdkError } = await import("@xpell/agent/adk");
const { _x, _xai, XNode } = await import("@xpell/node");
assert.equal("createAgent" in root, false, "legacy root surface stays unchanged");
const providerSnapshot = await _xai._list_providers();
const parent = await mkdtemp(join(tmpdir(), "xagent-adk-test-"));
const options = (name = "fixture-agent", folder = "runtime") => ({
  _name: name, _model: mockTextModel({ _text: "Hello from the mock" }),
  _channel: mockChannel({ _id: "local" }), _plugins: [],
  _host: { _work_folder: join(parent, folder), _listen: { _host: "127.0.0.1", _port: 0 } },
});
const absent = (path) => assert.rejects(access(path), { code: "ENOENT" });
const notReady = (app) => assert.rejects(app.testTurn({ _text: "hello" }), { _code: "E_ADK_NOT_READY" });
let app;
let foreign;
const scenario = process.argv[2];
try {
  if (scenario === "config") {
    for (const change of [
      (o) => { delete o._host; },
      (o) => { delete o._host._listen; },
      (o) => { o._host._listen._host = "0.0.0.0"; },
      (o) => { o._host._listen._host = { toString: () => "127.0.0.1" }; },
      (o) => { o._host._listen._port = -1; },
      (o) => { o._host._listen._port = NaN; },
      (o) => { o._host._work_folder = "relative"; },
      (o) => { o._model = { _type: "live-provider", _text: "hi" }; },
      (o) => { o._plugins = [{ _id: "unapproved" }]; },
      (o) => { o._storage = { _provider: "sqlite" }; },
      (o) => { o._principal = "unverified"; },
    ]) {
      const o = options(); change(o);
      assert.throws(() => createAgent(o), AgentAdkError);
    }
    assert.throws(() => createAgent(options("Invalid Agent")));
    assert.equal(servers.size, 0);
    await absent(join(parent, "runtime"));
  } else if (scenario === "existing-folder") {
    const o = options();
    await mkdir(o._host._work_folder);
    const sentinel = join(o._host._work_folder, "fixture.txt");
    await writeFile(sentinel, "synthetic existing work");
    app = createAgent(o);
    await assert.rejects(app.start(), { code: "EEXIST" });
    await app.close();
    assert.equal(await readFile(sentinel, "utf8"), "synthetic existing work");
    assert.equal(_x.isRunning(), false);
    app = createAgent(options("another-agent", "new-runtime"));
    mayListen = true;
    await app.start();
    assert.equal(await app.testTurn({ _text: "hello" }), "Hello from the mock");
  } else if (scenario === "foreign-host") {
    mayListen = true;
    foreign = new XNode();
    await foreign.start({ _work_folder: join(parent, "foreign"), _host: "127.0.0.1", _port: 0,
      _web_settings: { "enable-wormhole": false, "enable-ssl": false } });
    app = createAgent(options());
    await assert.rejects(app.start(), { _code: "E_ADK_HOST_IN_USE" });
    await app.close();
    assert.equal(_x.isRunning(), true, "rejected facade must not stop foreign Core");
    assert.equal(foreign._web_server._web_server.listening, true);
    await absent(join(parent, "runtime"));
  } else {
    const o = options();
    if (scenario === "zero-plugins") delete o._plugins;
    app = createAgent(o);
    assert.equal(app.getStatus()._state, "created");
    assert.equal(_x.isRunning(), false);
    assert.equal(servers.size, 0);
    await absent(o._host._work_folder);
    await notReady(app);
    if (scenario === "close-before-start") {
      assert.equal(app.close(), app.close());
      await app.close();
      await assert.rejects(app.start(), { _code: "E_ADK_CLOSED" });
      await absent(o._host._work_folder);
      assert.equal(servers.size, 0);
    } else if (scenario === "close-during-start") {
      const started = assert.rejects(app.start(), { _code: "E_ADK_CLOSED" });
      await app.close(); await started;
      assert.equal(servers.size, 0);
    } else if (scenario === "failed-listen") {
      mayListen = true;
      const blocker = net.createServer();
      await new Promise((resolve) => blocker.listen({ host: "127.0.0.1", port: 0 }, resolve));
      app = createAgent({ ...o, _host: { ...o._host,
        _listen: { _host: "127.0.0.1", _port: blocker.address().port } } });
      try {
        await assert.rejects(app.start(), { code: "EADDRINUSE" });
        assert.equal(app.getStatus()._state, "closed");
        await app.close();
        assert.equal(_x.isRunning(), false);
        assert.equal(blocker.listening, true, "cleanup must preserve foreign listener");
      } finally { await new Promise((resolve) => blocker.close(resolve)); }
    } else if (scenario === "close-during-node-start") {
      mayListen = true;
      let entered;
      const gate = new Promise((resolve) => { entered = resolve; });
      const start = XNode.prototype.start;
      XNode.prototype.start = function (opts) { const p = start.call(this, opts); entered(); return p; };
      const started = assert.rejects(app.start());
      await gate;
      await app.close(); await started;
      assert.equal(_x.isRunning(), false);
    } else {
      // Creation snapshots config; later caller mutation must not alter behavior.
      o._model = mockTextModel({ _text: "mutated" });
      o._channel = mockChannel({ _id: "mutated" });
      mayListen = true;
      assert.equal(app.start(), app.start());
      await app.start();
      assert.equal(app.getStatus()._state, "ready");
      assert.equal(app.getStatus()._channels[0]._id, "local");
      await assert.rejects(app.testTurn({ _text: "" }), AgentAdkError);
      await assert.rejects(app.testTurn({ _text: "hello", _principal: "spoofed" }), AgentAdkError);
      if (scenario === "competing-hosts") {
        const other = createAgent(options("other-agent", "other"));
        await assert.rejects(other.start(), { _code: "E_ADK_HOST_IN_USE" });
        await other.close();
        await absent(join(parent, "other"));
        assert.equal(_x.isRunning(), true);
      }
      const calls = [];
      const execute = _x.execute;
      let release;
      const gate = scenario === "drain-turn" ? new Promise((r) => { release = r; }) : Promise.resolve();
      _x.execute = async function (cmd) { calls.push(cmd); await gate; return execute.call(this, cmd); };
      const turn = app.testTurn({ _text: "hello" });
      if (scenario === "drain-turn") {
        const closing = app.close();
        assert.equal(app.getStatus()._state, "closing");
        await notReady(app);
        assert.equal(_x.isRunning(), true, "existing turn drains before host stop");
        release();
        assert.equal(await turn, "Hello from the mock");
        await closing;
      } else {
        assert.equal(await turn, "Hello from the mock");
        assert.deepEqual(await Promise.all([app.testTurn({ _text: "one" }), app.testTurn({ _text: "two" })]),
          ["Hello from the mock", "Hello from the mock"]);
      }
      assert.ok(calls.every((c) => c._module === "fixture-agent" && c._op === "receive-message"));
      assert.equal(calls[0]._params._channel_id, "local");
      assert.equal(calls[0]._params._external_user_id, "mock-participant");
      assert.equal(calls.length, scenario === "drain-turn" ? 1 : 3,
        "egress must call owned Channel directly, never re-enter the engine");
      _x.execute = execute;
      assert.equal(app.close(), app.close());
      await app.close();
      assert.equal(_x.isRunning(), false);
      await notReady(app);
      await assert.rejects(app.start(), { _code: "E_ADK_CLOSED" });
      if (scenario === "terminal-host") {
        const other = createAgent(options("other-agent", "other"));
        await assert.rejects(other.start(), (e) => e?._code === "E_XNODE_RESTART_REQUIRES_PROCESS");
        await other.close();
      }
    }
  }
} finally {
  try { await app?.close(); }
  finally {
    try { await foreign?.stop(); }
    finally { await rm(parent, { recursive: true, force: true }); }
  }
}
assert.equal(attempts, 0, "no outbound network/provider calls, including at import");
assert.ok([...servers].every((server) => !server.listening), "all owned listeners closed");
assert.deepEqual(await _xai._list_providers(), providerSnapshot, "global provider registry untouched");
console.log("ADK_SCENARIO_PASS", scenario);
