import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

let allowed = false, network = 0, starts = 0;
const servers = new Set(), listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  assert.ok(allowed, "no import/construction listener");
  assert.ok(["127.0.0.1", "::1"].includes(args[0]?.host)); servers.add(this);
  return listen.apply(this, args);
};
const deny = () => { network++; throw new Error("E_OFFLINE_ONLY"); };
globalThis.fetch = deny; net.Socket.prototype.connect = deny;
http.request = http.get = https.request = https.get = deny; syncBuiltinESMExports();

const { createAgentHost, AgentHostError } = await import("@xpell/agent/adk/host");
const { createAgent, mockChannel, mockTextModel } = await import("@xpell/agent/adk");
const { _x, _xai, XNode } = await import("@xpell/node");
const originalStart = XNode.prototype.start;
XNode.prototype.start = function (...args) { starts++; return originalStart.apply(this, args); };
const providers = await _xai._list_providers();
const parent = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "adk-host-")));
const source = join(parent, "source"), work = join(parent, "work"), viewFile = join(source, "views/view-main.json");
await fs.cp(fileURLToPath(new URL("./fixtures/host-view", import.meta.url)), source, { recursive: true });
const original = new Map(await Promise.all(["app.json", "views/view-main.json"].map(async p => [p, await fs.readFile(join(source, p))])));
const digest = async () => {
  const h = createHash("sha256"); for (const p of [...original.keys()].sort()) {
    const b = await fs.readFile(join(source, p)); h.update(p + "\0" + b.length + "\0").update(b);
  } return h.digest("hex");
};
const config = () => ({ _name: "host-agent", _model: mockTextModel({ _text: "neutral reply" }),
  _channel: mockChannel({ _id: "local" }), _plugins: [], _host: { _work_folder: work, _listen: { _host: "127.0.0.1", _port: 0 } } });
const options = async () => ({ _profile: { _type: "foundation", _options: config() },
  _system_apps: [{ _app_id: "sample-host", _env: "default", _source_dir: source, _sha256: await digest() }] });
const missing = p => assert.rejects(fs.access(p), { code: "ENOENT" });
const failure = e => e instanceof AgentHostError && /^E_ADK_/.test(e._code) && !JSON.stringify(e).includes(parent) && !e.message.includes("RAW_FAILURE");
const gate = () => { let release, entered; const wait = new Promise(r => { release = r; }); const reached = new Promise(r => { entered = r; }); return { wait, release, reached, entered }; };
const mode = process.argv[2]; let app, other, blocker, mutatedSource = false;
const execute = _x.execute, mkdir = fs.mkdir, open = fs.open, opendir = fs.opendir, writeFile = fs.writeFile, loadModule = _x.loadModuleAsync;
try {
  let o = await options();
  if (mode === "zero") delete o._system_apps;
  if (mode === "config") {
    let getters = 0;
    const bad = [
      { ...o, _routes: [] }, { ...o, _profile: { _type: "actions", _options: config() } },
      { ...o, _system_apps: [...o._system_apps, ...o._system_apps] },
      { ...o, get _profile() { getters++; return o._profile; } },
      new Proxy(o, { get() { getters++; return undefined; }, ownKeys() { getters++; return []; } }),
      { ...o, _profile: { _type: "foundation", _options: { ...config(), get _model() { getters++; return null; } } } },
      { ...o, _profile: { _type: "foundation", _options: { ...config(), _plugins: [{ _id: "blocked" }] } } },
      { ...o, _system_apps: [Object.defineProperty({}, "_app_id", { enumerable: true, get() { getters++; return "sample-host"; } })] },
      { ...o, _system_apps: Object.defineProperty([null], "0", { enumerable: true, get() { getters++; return null; } }) },
    ];
    for (const value of bad) assert.throws(() => createAgentHost(value), failure);
    assert.equal(getters, 0); assert.equal(starts, 0); await missing(work);
  } else if (mode === "source-work-overlap") {
    for (const folder of [source, join(source, "new-work"), parent]) {
      const raw = await options(); raw._profile._options._host._work_folder = folder;
      assert.throws(() => createAgentHost(raw), { _code: "E_ADK_HOST_RESOURCE_CONFLICT" });
    }
    await missing(work);
  } else if (mode === "source-inode-overlap") {
    o._system_apps[0]._source_dir = join(parent, "SOURCE"); o._profile._options._host._work_folder = join(source, "new-work");
    app = createAgentHost(o); await assert.rejects(app.start(), failure); await app.close(); await missing(join(source, "new-work"));
  } else if (mode === "parent-symlink") {
    const target = join(parent, "target"), alias = join(parent, "parent-alias");
    await fs.mkdir(target); await fs.symlink(target, alias); o._profile._options._host._work_folder = join(alias, "work");
    app = createAgentHost(o); await assert.rejects(app.start(), failure); await app.close(); await missing(join(target, "work"));
  } else if (mode === "paths") {
    for (const p of ["relative", source + "/../source", source + "/", source + "\0", source + "\\escape"]) {
      const raw = await options(); raw._system_apps[0]._source_dir = p;
      assert.throws(() => createAgentHost(raw), failure);
    }
    const raw = await options(); raw._profile._options._host._work_folder = work + "/../work";
    assert.throws(() => createAgentHost(raw), failure); await missing(work);
  } else if (["symlinks", "digest", "collision", "extra-files", "bounds", "invalid-json", "invalid-view", "existing", "source-change-during-read",
    "source-directory-symlink", "hardlink", "directory-bound", "oversize-total"].includes(mode)) {
    if (mode === "symlinks") {
      const alias = join(parent, "alias"); await fs.symlink(source, alias); o._system_apps[0]._source_dir = alias;
      app = createAgentHost(o); await assert.rejects(app.start(), failure); await missing(work); await app.close();
      o = await options(); await fs.rename(viewFile, join(parent, "saved-view")); await fs.symlink(join(parent, "saved-view"), viewFile); mutatedSource = true;
    } else if (mode === "source-directory-symlink") {
      await fs.rename(join(source, "views"), join(parent, "views")); await fs.symlink(join(parent, "views"), join(source, "views"));
    } else if (mode === "hardlink") {
      await fs.link(viewFile, join(parent, "hardlink"));
    } else if (mode === "directory-bound") {
      for (let i = 0; i < 8; i++) await fs.writeFile(join(source, "extra-" + i), "neutral");
      let reads = 0; fs.opendir = async (...args) => {
        const dir = await opendir(...args);
        return { read: async () => { reads++; assert.ok(reads <= 3, "directory scan stops at first excess entry"); return dir.read(); }, close: () => dir.close() };
      }; syncBuiltinESMExports();
    } else if (mode === "oversize-total") {
      for (const [path, bytes] of original) await fs.writeFile(join(source, path), Buffer.concat([bytes, Buffer.from(" ".repeat(33000))])); mutatedSource = true;
    } else if (mode === "digest") o._system_apps[0]._sha256 = "0".repeat(64);
    else if (mode === "collision") o._system_apps[0]._app_id = "other-app";
    else if (mode === "extra-files") await fs.mkdir(join(source, "entities"));
    else if (mode === "bounds") { await fs.writeFile(viewFile, " ".repeat(65537)); mutatedSource = true; }
    else if (mode === "invalid-json") { await fs.writeFile(viewFile, "{"); o._system_apps[0]._sha256 = await digest(); mutatedSource = true; }
    else if (mode === "invalid-view") { await fs.writeFile(viewFile, '{"_id":"view-main","_type":"view","_children":[],"_on":{"click":"write"}}'); o._system_apps[0]._sha256 = await digest(); mutatedSource = true; }
    else if (mode === "existing") { await fs.mkdir(work); await fs.writeFile(join(work, "sentinel"), "keep"); }
    else if (mode === "source-change-during-read") {
      fs.open = async (...args) => { const h = await open(...args); if (args[0] === viewFile) { await fs.appendFile(viewFile, " "); mutatedSource = true; } return h; }; syncBuiltinESMExports();
    }
    app = createAgentHost(o); await assert.rejects(app.start(), failure); await app.close();
    assert.equal(starts, 0); assert.equal(_x.isRunning(), false);
    if (mode === "existing") assert.equal(await fs.readFile(join(work, "sentinel"), "utf8"), "keep"); else await missing(work);
    if (mode === "collision") { const bad = await options(); bad._system_apps[0]._app_id = "xpell-agent-starter"; assert.throws(() => createAgentHost(bad), { _code: "E_ADK_HOST_RESOURCE_CONFLICT" }); }
  } else if (mode === "foreign" || mode === "foreign-after-preflight") {
    allowed = true; other = new XNode();
    const foreignOptions = { _work_folder: join(parent, "foreign"), _host: "127.0.0.1", _port: 0, _web_settings: { "enable-wormhole": false, "enable-ssl": false } };
    if (mode === "foreign") await other.start(foreignOptions);
    else XNode.prototype.start = async function (opts) { await originalStart.call(other, foreignOptions); return originalStart.call(this, opts); };
    app = createAgentHost(o); await assert.rejects(app.start(), mode === "foreign" ? { _code: "E_ADK_HOST_IN_USE" } : failure); await app.close();
    assert.equal(_x.isRunning(), true); assert.equal(other._web_server._web_server.listening, true); if (mode === "foreign") await missing(work);
  } else {
    app = createAgentHost(o); assert.equal(starts, 0); assert.equal(servers.size, 0); await missing(work);
    await assert.rejects(app.testTurn({ _text: "hi" }), { _code: "E_ADK_NOT_READY" });
    if (mode === "snapshot-config") {
      o._system_apps[0]._sha256 = "0".repeat(64); o._system_apps[0]._app_id = "changed";
      o._profile._options._host._work_folder = join(parent, "wrong"); o._profile._options._model = mockTextModel({ _text: "changed" });
    }
    if (mode === "snapshot-files") {
      fs.mkdir = async (...args) => { if (args[0] === work) { await fs.writeFile(viewFile, '{"_id":"changed"}'); mutatedSource = true; } return mkdir(...args); }; syncBuiltinESMExports();
    }
    if (mode === "close-before") { assert.equal(app.close(), app.close()); await app.close(); await assert.rejects(app.start(), { _code: "E_ADK_CLOSED" }); await missing(work); }
    else if (mode === "close-preflight") {
      const g = gate(); fs.open = async (...args) => { const h = await open(...args); if (args[0] === viewFile) { g.entered(); await g.wait; } return h; }; syncBuiltinESMExports();
      const start = assert.rejects(app.start(), failure); await g.reached; const closing = app.close(); assert.equal(app.getStatus()._state, "closing"); g.release(); await start; await closing; await missing(work);
    } else if (mode === "close-node-start") {
      const g = gate(); XNode.prototype.start = async function (...args) { g.entered(); await g.wait; return originalStart.apply(this, args); };
      const start = assert.rejects(app.start(), failure); await g.reached; const closing = app.close(); g.release(); await start; await closing;
    } else if (mode === "close-verify") {
      const g = gate(); _x.execute = async function (cmd) { const r = await execute.call(this, cmd); if (cmd._op === "get-view") { g.entered(); await g.wait; } return r; };
      allowed = true; const start = assert.rejects(app.start(), failure); await g.reached; const closing = app.close(); g.release(); await start; await closing;
    } else {
      if (mode === "failed-listen") { allowed = true; blocker = net.createServer(); await new Promise(r => blocker.listen({ host: "127.0.0.1", port: 0 }, r));
        o = await options(); o._profile._options._host._listen._port = blocker.address().port; app = createAgentHost(o); }
      if (mode === "failed-verify") _x.execute = async function (cmd) { const r = await execute.call(this, cmd); if (cmd._op === "get-view") r._result._view = { _id: "wrong" }; return r; };
      if (mode === "failed-start" || mode === "startup-cleanup-failure") XNode.prototype.start = async function (opts) { await originalStart.call(this, opts); throw Error("RAW_FAILURE"); };
      if (mode === "startup-cleanup-failure") { const stop = XNode.prototype.stop; XNode.prototype.stop = async function () { await stop.call(this); throw Error("RAW_FAILURE"); }; }
      if (mode === "partial-materialize") { fs.writeFile = async (...args) => { if (String(args[0]).includes("adk-host-resources") && String(args[0]).endsWith("view-main.json")) throw Error("RAW_FAILURE"); return writeFile(...args); }; syncBuiltinESMExports(); }
      if (mode === "failed-node-partial") _x.loadModuleAsync = async function (mod) { if (mod._name === "entity-manager") throw Error("RAW_FAILURE"); return loadModule.call(this, mod); };
      allowed = true;
      if (["failed-listen", "failed-verify", "failed-start", "partial-materialize", "failed-node-partial", "startup-cleanup-failure"].includes(mode)) {
        await assert.rejects(app.start(), mode === "startup-cleanup-failure" ? { _code: "E_ADK_HOST_CLEANUP" } : failure);
        if (mode === "startup-cleanup-failure") await assert.rejects(app.close(), { _code: "E_ADK_HOST_CLEANUP" }); else await app.close();
        if (blocker) assert.equal(blocker.listening, true);
      } else {
        assert.equal(app.start(), app.start()); await app.start(); assert.equal(starts, 1);
        assert.equal(app.getStatus()._state, "ready"); assert.equal(app.getStatus()._resources, "ready");
        const loaded = await _x.execute({ _module: "server-xvm", _op: "list-apps", _params: { _include_system: true } });
        assert.deepEqual(loaded._result._app_ids, mode === "zero" ? [] : ["sample-host"]);
        if (mode !== "zero") { const r = await _x.execute({ _module: "server-xvm", _op: "get-view", _params: { _app_id: "sample-host", _env: "default", _view_id: "view-main" } });
          assert.deepEqual(r._result._view, JSON.parse(original.get("views/view-main.json"))); }
        if (mode === "view") {
          await assert.rejects(_x.execute({ _module: "server-xvm", _op: "push-update", _params: { _app_id: "sample-host", _env: "default", _view: { _id: "view-main", _type: "view", _children: [] } } }), { _code: "E_XVM_READONLY" });
        }
        if (mode === "competing" || mode === "legacy-competing") {
          const raw = await options(); raw._profile._options._host._work_folder = join(parent, "second"); raw._profile._options._name = "other-agent";
          const competitor = mode === "competing" ? createAgentHost(raw) : createAgent(raw._profile._options);
          await assert.rejects(competitor.start(), { _code: "E_ADK_HOST_IN_USE" }); await competitor.close(); await missing(join(parent, "second")); assert.equal(_x.isRunning(), true);
        }
        if (mode === "failed-cleanup") { const stop = XNode.prototype.stop; XNode.prototype.stop = async function () { await stop.call(this); throw Error("RAW_FAILURE"); };
          await assert.rejects(app.close(), { _code: "E_ADK_HOST_CLEANUP" }); }
        else {
          const g = gate(); _x.execute = async function (cmd) { if (mode === "drain" && cmd._op === "receive-message") { g.entered(); await g.wait; } return execute.call(this, cmd); };
          const turn = app.testTurn({ _text: "hi" });
          if (mode === "drain") { await g.reached; const close = app.close(); assert.equal(_x.isRunning(), true); await assert.rejects(app.testTurn({ _text: "later" }), { _code: "E_ADK_NOT_READY" }); g.release(); assert.equal(await turn, "neutral reply"); await close; }
          else { assert.equal(await turn, "neutral reply"); assert.equal(app.close(), app.close()); await app.close(); }
        }
        if (mode === "snapshot-files") assert.equal(mutatedSource, true, "mutation hook ran after preflight");
        if (mode === "terminal") { const raw = await options(); raw._profile._options._host._work_folder = join(parent, "terminal"); const second = createAgentHost(raw); await assert.rejects(second.start(), failure); await second.close(); }
      }
    }
    assert.equal(app.getStatus()._state, "closed"); assert.equal(app.getStatus()._resources, "closed");
    await assert.rejects(app.start(), { _code: "E_ADK_CLOSED" });
  }
  if (!["foreign", "foreign-after-preflight"].includes(mode)) assert.equal(_x.isRunning(), false);
  if (!mutatedSource) for (const [path, bytes] of original) assert.deepEqual(await fs.readFile(join(source, path)), bytes, "source resource unchanged");
} finally {
  fs.mkdir = mkdir; fs.open = open; fs.opendir = opendir; fs.writeFile = writeFile; syncBuiltinESMExports(); _x.execute = execute; _x.loadModuleAsync = loadModule;
  await app?.close().catch(() => {}); await other?.stop();
  if (blocker) await new Promise(r => blocker.close(r));
  await fs.rm(parent, { recursive: true, force: true });
}
assert.equal(network, 0); assert.ok([...servers].every(s => !s.listening));
assert.deepEqual(await _xai._list_providers(), providers);
console.log("HOST_PASS", mode);
