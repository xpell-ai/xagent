import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile, symlink, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import net from "node:net";
import http from "node:http";
import https from "node:https";

let attempts = 0, mayListen = false;
const servers = new Set(), listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  assert.ok(mayListen); assert.equal(args[0]?.host, "127.0.0.1");
  servers.add(this); return listen.apply(this, args);
};
const denyNetwork = () => { attempts++; throw Error("unexpected network/provider call"); };
globalThis.fetch = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
http.request = http.get = https.request = https.get = denyNetwork;
syncBuiltinESMExports();
const { defineAction, createDurableActions, DurableActionError } = await import("@xpell/agent/adk/actions");
const { _x, _xai, XNode } = await import("@xpell/node");
const root = await import("@xpell/agent"), adk = await import("@xpell/agent/adk");
assert.equal("createDurableActions" in root, false); assert.equal("createDurableActions" in adk, false);
const providers = await _xai._list_providers();
const require = createRequire(import.meta.url), Database = require("better-sqlite3");
const nodeRoot = dirname(require.resolve("@xpell/node/package.json"));
const { SQLiteEntityProvider } = await import(pathToFileURL(join(nodeRoot, "dist/XEntityManager/SQLiteEntityProvider.js")));
let disposed = 0;
const dispose = SQLiteEntityProvider.prototype.dispose;
SQLiteEntityProvider.prototype.dispose = async function (...a) { disposed++; return dispose.apply(this, a); };
const [scenario, parent, stage] = process.argv.slice(2), folder = join(parent, "runtime");
const db = new Database(join(parent, "synthetic-target.sqlite"));
db.pragma("journal_mode = WAL"); db.pragma("synchronous = FULL");
db.exec("CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, receipt TEXT NOT NULL)");
let calls = 0, preparation = "fixture", policy = () => true, clock = new Date("2026-01-01T00:00:00Z"), release;
let preparations = 0, denyPrepared = false;
const policyInputs = [], preparationArguments = [];
const wait = () => new Promise(r => { release = r; });
const count = () => db.prepare("SELECT count(*) AS n FROM receipts").get().n;
const schema = { type: "object", additionalProperties: false, properties: { text: { type: "string", minLength: 1, maxLength: 64 } }, required: ["text"] };
const commit = db.transaction(input => {
  const receipt = { _action_id: input._action_id, _binding_hash: input._binding_hash, _idempotency_key: input._idempotency_key,
    _outcome: { _status: "succeeded", _result: { text: input._arguments.text } } };
  db.prepare("INSERT INTO receipts (id,receipt) VALUES (?,?)").run(input._idempotency_key, JSON.stringify(receipt));
  return receipt;
});
const crash = () => { process.stdout.write(`ACTION_CRASH ${stage}\n`); process.kill(process.pid, "SIGKILL"); };
const action = (revision = "1") => defineAction({ _id: "sample.record", _description: "Synthetic local receipt", _revision: revision, _input_schema: schema,
  _prepare_action: ({ _arguments, _context, _signal }) => {
    preparations++; preparationArguments.push(_arguments);
    assert.ok(Object.isFrozen(_arguments)); assert.ok(Object.isFrozen(_context)); assert.ok(_signal instanceof AbortSignal);
    if (scenario === "deny-prepared-confirm" && preparations > 1) denyPrepared = true;
    if (scenario === "invalid-prepared-arguments") return { _arguments: { text: "x".repeat(65) }, _authorized_scope: {}, _confirmation_summary: "Synthetic invalid preparation" };
    if (scenario === "changed-preparation" && preparation !== "fixture") return { _arguments, _authorized_scope: { changed: true }, _confirmation_summary: preparation };
    return { _arguments, _authorized_scope: { target: "synthetic-local" }, _confirmation_summary: `Record ${_arguments.text}` };
  },
  _handler: async input => {
    calls++; assert.ok(Object.isFrozen(input)); assert.ok(Object.isFrozen(input._authorized_scope));
    if (["timeout", "drain", "reconcile-busy"].includes(scenario)) await wait();
    if (scenario === "uncertain" || scenario === "seed" || scenario === "pagination") throw Error("SYNTHETIC_UNSAFE_EXCEPTION");
    if (scenario === "invalid-result") return { _status: "succeeded", _result: { bad: Infinity } };
    if (scenario === "known-failure" || scenario === "proposal-failed") return { _status: "failed", _failure_code: "E_SYNTHETIC_REFUSAL", _result: { detail: "synthetic-outcome" } };
    const receipt = commit(input);
    if (scenario === "proposal-uncertain") throw Error("SYNTHETIC_UNSAFE_EXCEPTION");
    if (scenario === "crash" && stage === "effect") crash();
    return receipt._outcome;
  },
  _read_committed_outcome: input => {
    if (scenario === "wrong-evidence") return { _action_id: "wrong", _binding_hash: input._binding_hash, _idempotency_key: input._idempotency_key, _outcome: { _status: "succeeded", _result: {} } };
    const row = db.prepare("SELECT receipt FROM receipts WHERE id=?").get(input._idempotency_key);
    return row ? JSON.parse(row.receipt) : null;
  },
});
const options = () => ({ _name: "actions-fixture", _instance_id: "fixture-instance", _application_scope: { _env: "test", _app_id: "synthetic-app" },
  _host: { _work_folder: folder, _listen: { _host: "127.0.0.1", _port: 0 } }, _actions: [action()],
  _policy: i => { policyInputs.push(i); return policy(i); }, _limits: { _timeout_ms: scenario === "timeout" ? 80 : 3000, _max_json_bytes: 2048 }, _now: () => clock });
const error = code => e => { assert.ok(e instanceof DurableActionError); assert.equal(e._code, code); assert.equal(e.cause, undefined); return true; };
const params = p => ({ _action_id: p._action_id, _binding_hash: p._binding_hash });
const entity = { _app_id: "xpell-agent-starter", _env: "default", _entity: "agent_action" };
const snapshot = async dir => {
  const out = {};
  for (const f of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    out[f.name] = f.isDirectory() ? await snapshot(p) : createHash("sha256").update(await readFile(p)).digest("hex");
  }
  return out;
};
let app, blocker, foreign;
try {
  const o = options();
  if (scenario === "config") {
    assert.equal(new DurableActionError("SYNTHETIC_UNSAFE_CODE")._code, "E_ADK_ACTION_STORAGE");
    for (const change of [x => { delete x._limits; }, x => { x._limits._timeout_ms = 5001; }, x => { x._limits._max_json_bytes = 8193; },
      x => { x._actions.push(action()); }, x => { x._policy = "allow"; }, x => { x._application_scope._app_id = "../bad"; },
      x => { x._host._listen._host = "0.0.0.0"; }]) {
      const x = options(); change(x); assert.throws(() => createDurableActions(x));
    }
    assert.throws(() => defineAction({ ...action(), _revision: "" }), error("E_ADK_ACTION_CONFIG"));
    assert.throws(() => defineAction({ ...action(), _input_schema: { type: "object" } }), error("E_ADK_ACTION_CONFIG"));
    await assert.rejects(access(folder), { code: "ENOENT" });
  } else {
    if (scenario === "deny") delete o._policy;
    if (scenario === "revision" || scenario === "revision-pending") o._actions = [action("2")];
    if (scenario === "missing-definition") o._actions = [];
    if (scenario === "scope-marker") o._application_scope = { _env: "test", _app_id: "different-app" };
    if (scenario === "profile") { await mkdir(folder); await writeFile(join(folder, ".adk-conversations.json"), "synthetic preserve"); }
    if (scenario === "symlink") { await mkdir(join(parent, "other")); await symlink(join(parent, "other"), folder); }
    if (scenario === "failed-start") {
      mayListen = true; blocker = net.createServer(); await new Promise(r => blocker.listen({ host: "127.0.0.1", port: 0 }, r));
      o._host._listen._port = blocker.address().port;
    }
    if (scenario === "partial-start") {
      const start = XNode.prototype.start;
      XNode.prototype.start = async function (input) { await start.call(this, input); await this.stop(); throw Error("synthetic post-registration failure"); };
    }
    if (scenario === "foreign-host") {
      mayListen = true; foreign = new XNode();
      await foreign.start({ _work_folder: join(parent, "foreign"), _host: "127.0.0.1", _port: 0, _web_settings: { "enable-wormhole": false, "enable-ssl": false } });
    }
    app = createDurableActions(o);
    assert.throws(() => app.bindContext({ _actor_id: "actor", _conversation_id: "conversation", _delivery_id: "request" }), error("E_ADK_ACTION_NOT_READY"));
    if (["profile", "symlink", "scope-marker"].includes(scenario)) {
      const before = await snapshot(folder);
      await assert.rejects(app.start(), error("E_ADK_ACTION_PROFILE"));
      assert.deepEqual(await snapshot(folder), before);
      if (scenario === "profile") assert.equal(await readFile(join(folder, ".adk-conversations.json"), "utf8"), "synthetic preserve");
      assert.equal(disposed, 0);
    } else if (scenario === "failed-start") {
      await assert.rejects(app.start()); await app.close(); assert.equal(disposed, 0);
    } else if (scenario === "partial-start") {
      mayListen = true; await assert.rejects(app.start()); await app.close(); assert.equal(disposed, 5);
    } else if (scenario === "foreign-host") {
      await assert.rejects(app.start(), error("E_ADK_ACTION_BUSY")); await app.close();
      assert.equal(_x.isRunning(), true); assert.equal(foreign._web_server._web_server.listening, true); assert.equal(disposed, 0);
      await assert.rejects(access(folder), { code: "ENOENT" });
    } else {
      mayListen = true; await app.start(); await app.start();
      const ctx = (delivery = "request", actor = "actor", conversation = "conversation") => app.bindContext({ _actor_id: actor, _conversation_id: conversation, _delivery_id: delivery });
      const request = ctx(), confirm = ctx("explicit-confirm"), proposal = () => app.prepare({ _capability_id: "sample.record", _arguments: { text: "hello" } }, request);
      const diagnostic = await _x.execute({ _module: "entity-manager", _op: "storage-diagnostics", _params: entity });
      assert.equal(diagnostic._ok, true); assert.equal(diagnostic._result._diagnostic._provider, "sqlite");
      assert.deepEqual(diagnostic._result._diagnostic._sqlite_pragmas, { _journal_mode: "wal", _synchronous: 2, _foreign_keys: 1, _busy_timeout: 5000 });
      if (scenario === "deny") {
        await assert.rejects(proposal(), error("E_ADK_ACTION_DENIED")); assert.equal(calls, 0);
      } else if (scenario === "argument-accessors" || scenario === "argument-proxies") {
        let reads = 0;
        const getter = () => { reads++; return reads === 1 ? "hello" : "x".repeat(100); };
        const accessor = (key, enumerable = true) => Object.defineProperty(key === "text" ? {} : { text: "hello" }, key, { enumerable, get: getter });
        const trap = () => { reads++; throw Error("SYNTHETIC_UNSAFE_EXCEPTION"); };
        const proxy = value => new Proxy(value, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
        const revoked = Proxy.revocable({ text: "hello" }, {}); revoked.revoke();
        const args = scenario === "argument-accessors" ? [accessor("text"), accessor("text", false), accessor("extra"), accessor("toJSON"),
          Object.create(Object.defineProperty({}, "text", { get: getter })), { text: "hello", [Symbol("invalid")]: "x" }] :
          [proxy({ text: "hello" }), revoked.proxy, { text: proxy({}) }, proxy([])];
        for (const value of args) await assert.rejects(app.prepare({ _capability_id: "sample.record", _arguments: value }, request), error("E_ADK_ACTION_CONFIG"));
        if (scenario === "argument-proxies") await assert.rejects(app.prepare(proxy({ _capability_id: "sample.record", _arguments: { text: "hello" } }), request), error("E_ADK_ACTION_CONFIG"));
        assert.equal(reads, 0); assert.equal(policyInputs.length, 0); assert.equal(preparations, 0); assert.equal(calls, 0);
      } else if (scenario === "argument-snapshot") {
        const original = { text: "hello" }; let first;
        policy = async i => {
          if (!first) { first = i._arguments; original.text = "changed after admission"; await Promise.resolve(); }
          assert.equal(i._arguments, first); assert.equal(i._arguments.text, "hello"); assert.ok(Object.isFrozen(i._arguments));
          return true;
        };
        const p = await app.prepare({ _capability_id: "sample.record", _arguments: original }, request);
        assert.equal(preparationArguments[0], first); assert.notEqual(first, original); assert.equal(preparations, 1); assert.equal(calls, 0);
        assert.deepEqual(Object.keys(p).sort(), ["_action_id", "_binding_hash", "_capability_id", "_confirmation_summary", "_expires_at", "_revision"]);
      } else if (["invalid-prepared-arguments", "deny-initial", "deny-prepared", "deny-prepared-throw"].includes(scenario)) {
        if (scenario === "deny-initial") policy = () => false;
        if (scenario === "deny-prepared") policy = i => i._authorized_scope === undefined;
        if (scenario === "deny-prepared-throw") policy = i => { if (i._authorized_scope !== undefined) throw Error("SYNTHETIC_UNSAFE_EXCEPTION"); return true; };
        await assert.rejects(proposal(), error(scenario === "invalid-prepared-arguments" ? "E_ADK_ACTION_CONFIG" : "E_ADK_ACTION_DENIED"));
        assert.equal(calls, 0); assert.equal(preparations, scenario === "deny-initial" ? 0 : 1);
        assert.equal(policyInputs.length, scenario.startsWith("deny-prepared") ? 2 : 1);
        assert.ok(policyInputs.every(i => typeof i._arguments.text === "string" && i._arguments.text.length <= 64));
        const rows = await _x.execute({ _module: "entity-manager", _op: "find", _params: { ...entity, _filter: {}, _limit: 10 } });
        assert.equal(rows._ok, true); assert.equal(rows._result._records._data.length, 0);
      } else if (scenario === "validation") {
        for (const args of [{}, { text: 1 }, { text: "x", extra: "no" }, { text: "x".repeat(65) }, Object.defineProperty({}, "text", { enumerable: true, get() { throw Error("SYNTHETIC_UNSAFE_EXCEPTION"); } })]) {
          await assert.rejects(app.prepare({ _capability_id: "sample.record", _arguments: args }, request));
        }
        await assert.rejects(app.prepare({ _capability_id: "missing", _arguments: { text: "x" } }, request), error("E_ADK_ACTION_UNAVAILABLE"));
        assert.equal(calls, 0); assert.equal(policyInputs.length, 0); assert.equal(preparations, 0);
      } else if (["recover", "replay", "revision", "revision-pending", "missing-definition", "wrong-evidence", "restart-policy"].includes(scenario)) {
        const p = JSON.parse(await readFile(join(parent, "proposal.json"), "utf8"));
        if (scenario === "revision") {
          assert.equal((await app.confirm(params(p), confirm))._state, "executing");
          await assert.rejects(app.reconcile({ _limit: 4 }, confirm), error("E_ADK_ACTION_UNAVAILABLE"));
        }
        else if (scenario === "revision-pending") await assert.rejects(app.confirm(params(p), confirm), error("E_ADK_ACTION_UNAVAILABLE"));
        else if (scenario === "missing-definition") await assert.rejects(app.get(p._action_id, confirm), error("E_ADK_ACTION_UNAVAILABLE"));
        else if (scenario === "wrong-evidence") { await assert.rejects(app.reconcile({ _limit: 4 }, confirm), error("E_ADK_ACTION_EVIDENCE")); assert.equal((await app.get(p._action_id, confirm))._state, "executing"); }
        else if (scenario === "restart-policy") {
          policy = () => false; await assert.rejects(app.confirm(params(p), confirm), error("E_ADK_ACTION_DENIED"));
          await assert.rejects(app.get(p._action_id, confirm), error("E_ADK_ACTION_DENIED"));
          await assert.rejects(app.reconcile({ _limit: 4 }, confirm), error("E_ADK_ACTION_DENIED"));
        } else {
          const before = count(), r = await app.get(p._action_id, confirm);
          if (scenario === "recover" && ["prepared", "confirmed"].includes(stage)) {
            assert.equal(r._state, stage === "prepared" ? "pending" : "confirmed");
            const scan = await app.reconcile({ _limit: 4 }, confirm); assert.equal(scan._completed, 0); assert.equal(calls, 0);
            assert.equal((await app.confirm(params(p), confirm))._state, "succeeded"); assert.equal(calls, 1);
          } else {
            const replay = await app.confirm(params(p), confirm); assert.equal(calls, 0);
            assert.equal(replay._state, ["claimed", "before-handler"].includes(stage) || scenario === "recover" && stage === "effect" ? "executing" : "succeeded");
            const scan = await app.reconcile({ _limit: 4 }, confirm);
            assert.equal(scan._completed, scenario === "recover" && stage === "effect" ? 1 : 0);
          }
          assert.equal(count(), ["prepared", "confirmed"].includes(stage) && scenario === "recover" ? before + 1 : before);
          const final = await app.get(p._action_id, confirm);
          assert.equal(final._state, ["claimed", "before-handler"].includes(stage) ? "executing" : "succeeded");
        }
        if (!["recover", "replay"].includes(scenario)) { assert.equal(calls, 0); assert.equal(count(), 0); }
      } else {
        if (scenario === "pagination") {
          for (let i = 0; i < 3; i++) { const p = await app.prepare({ _capability_id: "sample.record", _arguments: { text: "x" } }, ctx(`r${i}`)); await assert.rejects(app.confirm(params(p), confirm), error("E_ADK_ACTION_UNCERTAIN")); }
          let cursor, total = 0;
          do { const scan = await app.reconcile({ _limit: 1, ...(cursor ? { _after_id: cursor } : {}) }, confirm); total += scan._uncertain; cursor = scan._next_after_id; } while (cursor);
          assert.equal(total, 3); assert.equal(calls, 3);
          assert.equal((await app.reconcile({ _limit: 4 }, ctx("scan", "other-actor")))._uncertain, 0);
          await assert.rejects(app.reconcile({ _limit: 101 }, confirm), error("E_ADK_ACTION_CONFIG"));
        } else {
          const proposals = await Promise.all(Array.from({ length: scenario === "concurrency" ? 8 : 1 }, proposal));
          const p = proposals[0]; assert.ok(proposals.every(x => x._action_id === p._action_id));
          assert.equal((await app.get(p._action_id, confirm))._state, "pending"); assert.equal(calls, 0); assert.ok(Object.isFrozen(p));
          if (scenario.startsWith("proposal-")) {
            const expected = scenario.slice("proposal-".length) === "uncertain" ? "executing" : scenario.slice("proposal-".length);
            if (expected === "executing") await assert.rejects(app.confirm(params(p), confirm), error("E_ADK_ACTION_UNCERTAIN"));
            else assert.equal((await app.confirm(params(p), confirm))._state, expected);
            const stored = await app.get(p._action_id, confirm); assert.equal(stored._state, expected);
            policy = i => i._phase === "prepare";
            await assert.rejects(app.get(p._action_id, confirm), error("E_ADK_ACTION_DENIED"));
            await assert.rejects(app.confirm(params(p), confirm), error("E_ADK_ACTION_DENIED"));
            const offset = policyInputs.length, replay = await proposal();
            assert.deepEqual(replay, p);
            assert.deepEqual(Object.keys(replay).sort(), ["_action_id", "_binding_hash", "_capability_id", "_confirmation_summary", "_expires_at", "_revision"]);
            for (const key of ["_state", "_uncertain", "_result", "_failure_code"]) assert.equal(Object.hasOwn(replay, key), false);
            assert.ok(policyInputs.slice(offset).every(i => i._phase === "prepare"));
            assert.equal(calls, 1); assert.equal(count(), expected === "failed" ? 0 : 1);
            policy = () => true; assert.deepEqual(await app.get(p._action_id, confirm), stored);
          } else if (scenario === "deny-prepared-confirm") {
            policy = i => !(denyPrepared && i._phase === "confirm");
            await assert.rejects(app.confirm(params(p), confirm), error("E_ADK_ACTION_DENIED"));
            assert.equal(preparations, 2); assert.equal(calls, 0);
            assert.equal((await app.get(p._action_id, confirm))._state, "pending");
          } else if (scenario === "authority") {
            for (const c of [{ ...confirm }, ctx("c", "other-actor"), ctx("c", "actor", "other-conversation")]) {
              await assert.rejects(app.confirm(params(p), c), error("E_ADK_ACTION_DENIED"));
            }
            await assert.rejects(app.confirm(params(p), request), error("E_ADK_ACTION_BINDING"));
            await assert.rejects(app.confirm({ ...params(p), _binding_hash: "wrong" }, confirm), error("E_ADK_ACTION_BINDING"));
            await assert.rejects(app.confirm({ _action_id: "missing", _binding_hash: p._binding_hash }, confirm), error("E_ADK_ACTION_NOT_FOUND"));
            policy = () => false; await assert.rejects(app.confirm(params(p), confirm), error("E_ADK_ACTION_DENIED")); assert.equal(calls, 0);
          } else if (scenario === "changed-preparation") {
            preparation = "changed"; await assert.rejects(app.confirm(params(p), confirm), error("E_ADK_ACTION_DENIED")); assert.equal(calls, 0);
          } else if (scenario === "expiry") {
            clock = new Date(clock.getTime() + 15 * 60_000); await assert.rejects(app.confirm(params(p), confirm), error("E_ADK_ACTION_EXPIRED"));
            assert.equal((await app.get(p._action_id, confirm))._state, "expired"); assert.equal(calls, 0);
          } else if (["execute-denial", "execute-expiry"].includes(scenario)) {
            policy = i => { if (i._phase === "execute") { if (scenario === "execute-denial") return false; clock = new Date(clock.getTime() + 15 * 60_000); } return true; };
            assert.equal((await app.confirm(params(p), confirm))._state, "failed"); assert.equal(calls, 0);
          } else if (scenario === "concurrency" || scenario === "cancel-race") {
            const jobs = Array.from({ length: 8 }, (_, i) => app.confirm(params(p), ctx(`confirm-${i}`)));
            if (scenario === "cancel-race") jobs.push(...Array.from({ length: 8 }, (_, i) => app.cancel(params(p), ctx(`cancel-${i}`))));
            const settled = await Promise.allSettled(jobs); assert.ok(settled.some(x => x.status === "fulfilled"));
            assert.ok(["succeeded", "cancelled"].includes((await app.get(p._action_id, confirm))._state)); assert.ok(calls <= 1); assert.equal(count(), calls);
          } else if (scenario === "tamper") {
            const protectedUpdate = await _x.execute({ _module: "entity-manager", _op: "update", _params: { ...entity, _filter: { _id: p._action_id }, _updates: { _arguments: { text: "tampered" } } } });
            assert.equal(protectedUpdate._ok, false);
            // Inject a corrupt read, without bypassing provider immutability on disk.
            const execute = _x.execute.bind(_x);
            _x.execute = async command => {
              const r = await execute(command);
              if (command._op === "get" && command._params?._entity === "agent_action" && r?._result?._record) r._result._record._arguments = { text: "tampered" };
              return r;
            };
            await assert.rejects(app.confirm(params(p), confirm), error("E_ADK_ACTION_BINDING")); assert.equal(calls, 0);
          } else if (scenario === "completion-failure" || scenario === "reconcile-race") {
            const execute = _x.execute.bind(_x); let failCompletion = true;
            _x.execute = command => {
              if (failCompletion && command._op === "update" && command._params?._entity === "agent_action" && command._params._updates._state === "succeeded")
                return Promise.resolve({ _ok: false, _error: { _code: "E_SYNTHETIC_STORAGE" } });
              return execute(command);
            };
            await assert.rejects(app.confirm(params(p), confirm), error("E_ADK_ACTION_UNCERTAIN")); assert.equal(count(), 1);
            assert.equal((await app.get(p._action_id, confirm))._state, "executing"); failCompletion = false;
            if (scenario === "completion-failure") assert.equal((await app.reconcile({ _limit: 4 }, confirm))._completed, 1);
            else {
              const scans = await Promise.allSettled([app.reconcile({ _limit: 4 }, confirm), app.reconcile({ _limit: 4 }, confirm)]);
              assert.equal(scans.filter(x => x.status === "fulfilled").length, 1);
              assert.equal(scans.find(x => x.status === "rejected").reason._code, "E_ADK_ACTION_BUSY");
            }
            assert.equal((await app.confirm(params(p), confirm))._state, "succeeded"); assert.equal(calls, 1);
          } else if (scenario === "known-failure") {
            const failed = await app.confirm(params(p), confirm); assert.equal(failed._state, "failed"); assert.equal(failed._failure_code, "E_SYNTHETIC_REFUSAL");
            assert.equal((await app.confirm(params(p), confirm))._state, "failed"); assert.equal(calls, 1); assert.equal(count(), 0);
          } else if (["timeout", "drain", "reconcile-busy"].includes(scenario)) {
            const work = app.confirm(params(p), confirm); const checked = work.catch(e => e);
            while (!release) await new Promise(r => setTimeout(r, 1));
            if (scenario === "timeout") {
              assert.equal((await checked)._code, "E_ADK_ACTION_UNCERTAIN");
              assert.equal((await app.get(p._action_id, confirm))._state, "executing");
              await assert.rejects(app.reconcile({ _limit: 4 }, confirm), error("E_ADK_ACTION_BUSY")); release();
              await new Promise(r => setTimeout(r, 10)); assert.equal(count(), 1);
              assert.equal((await app.reconcile({ _limit: 4 }, confirm))._completed, 1);
            } else if (scenario === "drain") {
              let closed = false; const closing = app.close().then(() => { closed = true; });
              await new Promise(r => setTimeout(r, 10)); assert.equal(closed, false);
              assert.throws(() => ctx("closed"), error("E_ADK_ACTION_CLOSED")); release(); await checked; await closing; assert.equal(closed, true);
            } else {
              await assert.rejects(app.reconcile({ _limit: 4 }, confirm), error("E_ADK_ACTION_BUSY")); release();
              assert.equal((await work)._state, "succeeded");
            }
          } else if (scenario === "seed-pending") {
            await writeFile(join(parent, "proposal.json"), JSON.stringify(p));
          } else if (["uncertain", "invalid-result", "seed"].includes(scenario)) {
            await assert.rejects(app.confirm(params(p), confirm), error("E_ADK_ACTION_UNCERTAIN"));
            assert.equal((await app.confirm(params(p), confirm))._state, "executing"); assert.equal(calls, 1);
            assert.equal((await app.reconcile({ _limit: 4 }, confirm))._uncertain, 1);
            if (scenario === "seed") await writeFile(join(parent, "proposal.json"), JSON.stringify(p));
          } else if (scenario === "crash") {
            await writeFile(join(parent, "proposal.json"), JSON.stringify(p));
            if (stage === "prepared") crash();
            const execute = _x.execute.bind(_x);
            _x.execute = async command => {
              const r = await execute(command);
              if (command._op === "update" && command._params?._entity === "agent_action" && r?._result?._updated === 1 &&
                ((stage === "confirmed" && command._params._updates._state === "confirmed") || (stage === "claimed" && command._params._updates._state === "executing"))) crash();
              return r;
            };
            policy = i => { if (stage === "before-handler" && i._phase === "execute") crash(); return true; };
            assert.equal((await app.confirm(params(p), confirm))._state, "succeeded");
            assert.equal(stage, "completed"); crash();
          } else {
            assert.equal((await proposal())._action_id, p._action_id);
            await assert.rejects(app.prepare({ _capability_id: "sample.record", _arguments: { text: "different" } }, request), error("E_ADK_ACTION_CONFLICT"));
            const done = await app.confirm(params(p), confirm); assert.equal(done._state, "succeeded"); assert.deepEqual(done._result, { text: "hello" });
            assert.equal((await app.confirm(params(p), confirm))._state, "succeeded"); assert.equal(calls, 1);
            policy = () => false; await assert.rejects(app.confirm(params(p), confirm), error("E_ADK_ACTION_DENIED")); policy = () => true;
            const c = await app.prepare({ _capability_id: "sample.record", _arguments: { text: "cancel" } }, ctx("cancel-request"));
            assert.equal((await app.cancel(params(c), confirm))._state, "cancelled");
            assert.equal((await app.cancel(params(c), confirm))._state, "cancelled");
            await assert.rejects(app.confirm(params(c), confirm), error("E_ADK_ACTION_STATE")); assert.equal(calls, 1);
          }
        }
      }
    }
  }
} finally {
  if (release) release();
  if (app) { await app.close(); await app.close(); }
  if (foreign) await foreign.stop();
  if (blocker) await new Promise(r => blocker.close(r));
  db.close();
}
assert.equal(attempts, 0); assert.equal(_x.isRunning(), false);
for (const server of servers) assert.equal(server.listening, false);
assert.deepEqual(await _xai._list_providers(), providers);
if (disposed) assert.equal(disposed, 5);
console.log(`ACTIONS_PASS ${scenario} ${stage} Node=${process.version} ABI=${process.versions.modules}`);
