import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import { _x } from "@xpell/node";
import type { FoundationResources } from "../foundation.js";

/** @experimental P2.2 integrity descriptor, not a finalized authoring workflow. */
export type HostSystemAppSource = Readonly<{
  _env: "default"; _app_id: string; _source_dir: string; _sha256: string;
}>;
export type HostResourceState = "unprepared" | "preparing" | "ready" | "closed";
export type AgentHostErrorCode = "E_ADK_HOST_CONFIG" | "E_ADK_HOST_RESOURCE" |
  "E_ADK_HOST_RESOURCE_CONFLICT" | "E_ADK_HOST_START" | "E_ADK_HOST_CLEANUP" |
  "E_ADK_HOST_IN_USE" | "E_ADK_CLOSED" | "E_ADK_NOT_READY" | "E_ADK_CONFIG";
export class AgentHostError extends Error {
  constructor(readonly _code: AgentHostErrorCode) {
    super("Experimental Agent Host failed; inspect the safe error code");
    this.name = "AgentHostError"; Object.freeze(this);
  }
}
export const fail = (code: AgentHostErrorCode): never => { throw new AgentHostError(code); };

// Reject getters/proxies before reading any caller-controlled configuration.
export function data(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("E_ADK_HOST_CONFIG");
  const ds = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(ds).some(k => typeof k !== "string" || !keys.includes(k) || !ds[k].enumerable || !("value" in ds[k]))) return fail("E_ADK_HOST_CONFIG");
  return Object.fromEntries(Object.entries(ds).map(([k, d]) => [k, d.value]));
}
export function list(value: unknown, max: number): unknown[] {
  if (!value || typeof value !== "object" || types.isProxy(value) || !Array.isArray(value)) return fail("E_ADK_HOST_CONFIG");
  const ds = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>, n = ds.length.value;
  if (!Number.isSafeInteger(n) || n > max || n < 0 || Reflect.ownKeys(ds).length !== n + 1) return fail("E_ADK_HOST_CONFIG");
  return Array.from({ length: n }, (_, i) => {
    const d = ds[String(i)]; if (!d || !("value" in d) || !d.enumerable) return fail("E_ADK_HOST_CONFIG"); return d.value;
  });
}
export function absolute(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0") || value.includes("\\") ||
      !isAbsolute(value) || value !== resolve(value) || value === parse(value).root) return fail("E_ADK_HOST_CONFIG");
  return value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) return fail("E_ADK_HOST_RESOURCE");
  return value;
}
export function descriptor(value: unknown): HostSystemAppSource {
  const d = data(value, ["_env", "_app_id", "_source_dir", "_sha256"]), app = id(d._app_id);
  if (/^(?:xpell|vibe|system)(?:-|$)/.test(app) || ["default", "server-xvm", "entity-manager", "xauth"].includes(app)) return fail("E_ADK_HOST_RESOURCE_CONFLICT");
  if (d._env !== "default" || typeof d._sha256 !== "string" || !/^[a-f0-9]{64}$/.test(d._sha256)) return fail("E_ADK_HOST_CONFIG");
  return Object.freeze({ _env: "default", _app_id: app, _source_dir: absolute(d._source_dir), _sha256: d._sha256 });
}
type Identity = { path: string; dev: number; ino: number };
async function ancestry(path: string): Promise<Identity[]> {
  const paths = [parse(path).root];
  for (const s of path.slice(paths[0].length).split(sep).filter(Boolean)) paths.push(join(paths.at(-1)!, s));
  const result: Identity[] = [];
  for (const path of paths) {
    const s = await lstat(path);
    if (!s.isDirectory() || s.isSymbolicLink()) return fail("E_ADK_HOST_RESOURCE");
    result.push({ path, dev: s.dev, ino: s.ino });
  }
  return result;
}
async function unchanged(ids: readonly Identity[]): Promise<void> {
  for (const i of ids) {
    const s = await lstat(i.path);
    if (!s.isDirectory() || s.isSymbolicLink() || s.dev !== i.dev || s.ino !== i.ino) return fail("E_ADK_HOST_RESOURCE");
  }
}
async function absent(path: string): Promise<void> {
  try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  return fail("E_ADK_HOST_RESOURCE_CONFLICT");
}
const MAX = 65536;
async function names(path: string, max: number): Promise<string[]> {
  const dir = await opendir(path, { bufferSize: max + 1 });
  const result: string[] = [];
  try {
    for (;;) {
      const entry = await dir.read(); if (!entry) break;
      if (result.length === max) return fail("E_ADK_HOST_RESOURCE");
      result.push(entry.name);
    }
    return result.sort();
  } finally { await dir.close(); }
}
async function boundedFile(path: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX) return fail("E_ADK_HOST_RESOURCE");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await handle.stat();
    if (!s.isFile() || s.nlink !== 1 || s.dev !== before.dev || s.ino !== before.ino || s.size !== before.size || s.size > MAX) return fail("E_ADK_HOST_RESOURCE");
    const b = Buffer.alloc(MAX + 1); let length = 0;
    while (length < b.length) { const r = await handle.read(b, length, b.length - length, null); if (!r.bytesRead) break; length += r.bytesRead; }
    const after = await handle.stat(), current = await lstat(path);
    if (length > MAX || length !== s.size || s.size !== after.size || s.mtimeMs !== after.mtimeMs || s.ctimeMs !== after.ctimeMs ||
        current.isSymbolicLink() || current.dev !== s.dev || current.ino !== s.ino) return fail("E_ADK_HOST_RESOURCE");
    return b.subarray(0, length);
  } finally { await handle.close(); }
}
type Snapshot = { app: string; viewId: string; view: unknown; files: readonly [string, Buffer][] };
async function snapshot(d: HostSystemAppSource): Promise<Snapshot> {
  const parents = await ancestry(d._source_dir);
  if (!isDeepStrictEqual(await names(d._source_dir, 2), ["app.json", "views"])) return fail("E_ADK_HOST_RESOURCE");
  const viewPath = join(d._source_dir, "views"), viewParents = await ancestry(viewPath), views = await names(viewPath, 1);
  if (views.length !== 1 || !views[0].endsWith(".json")) return fail("E_ADK_HOST_RESOURCE");
  const viewId = id(views[0].slice(0, -5));
  const files: [string, Buffer][] = [["app.json", await boundedFile(join(d._source_dir, "app.json"))],
    [`views/${viewId}.json`, await boundedFile(join(viewPath, views[0]))]];
  if (files.reduce((n, f) => n + f[1].length, 0) > MAX) return fail("E_ADK_HOST_RESOURCE");
  const hash = createHash("sha256");
  for (const [path, bytes] of files) hash.update(path + "\0" + bytes.length + "\0").update(bytes);
  if (hash.digest("hex") !== d._sha256) return fail("E_ADK_HOST_RESOURCE");
  const decode = (b: Buffer) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b));
  const app = data(decode(files[0][1]), ["_app_id", "_env", "_meta"]);
  const meta = data(app._meta, ["_entry_view_id"]);
  if (app._app_id !== d._app_id || app._env !== d._env || meta._entry_view_id !== viewId) return fail("E_ADK_HOST_RESOURCE_CONFLICT");
  const view = data(decode(files[1][1]), ["_id", "_type", "_children"]);
  if (view._id !== viewId || view._type !== "view" || list(view._children, 0).length) return fail("E_ADK_HOST_RESOURCE");
  await unchanged(parents); await unchanged(viewParents);
  if (!isDeepStrictEqual(await names(d._source_dir, 2), ["app.json", "views"]) ||
      !isDeepStrictEqual(await names(viewPath, 1), views)) return fail("E_ADK_HOST_RESOURCE");
  return { app: d._app_id, viewId, view, files };
}

/** Package-private snapshot port. No user callbacks, host, schema or route registration. */
export function resourcePort(folder: string, source?: HostSystemAppSource): FoundationResources & { state(): HostResourceState } {
  if (source && (folder === source._source_dir || folder.startsWith(source._source_dir + sep) || source._source_dir.startsWith(folder + sep)))
    return fail("E_ADK_HOST_RESOURCE_CONFLICT");
  const root = join(folder, "adk-host-resources");
  let state: HostResourceState = "unprepared", saved: Snapshot | undefined, parents: Identity[] = [];
  const safe = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) { if (e instanceof AgentHostError) throw e; return fail("E_ADK_HOST_RESOURCE"); }
  };
  return Object.freeze({
    _system_xapps_path: source ? root : undefined,
    state: () => state,
    preflight: () => safe(async () => {
      state = "preparing"; parents = await ancestry(dirname(folder)); await absent(folder);
      if (source) {
        const root = await lstat(source._source_dir);
        // Also catch native case/bind aliases that textual containment cannot see.
        if (parents.some(p => p.dev === root.dev && p.ino === root.ino)) return fail("E_ADK_HOST_RESOURCE_CONFLICT");
        saved = await snapshot(source);
      }
    }),
    materialize: () => safe(async () => {
      await unchanged(parents); await ancestry(folder);
      if (!saved) return;
      await mkdir(root, { mode: 0o700 });
      const app = join(root, saved.app); await mkdir(app, { mode: 0o700 }); await mkdir(join(app, "views"), { mode: 0o700 });
      for (const [path, bytes] of saved.files) await writeFile(join(app, path), bytes, { flag: "wx", mode: 0o600 });
    }),
    afterStart: () => safe(async () => {
      // Native read-only commands prove the actual XVM graph, not just copied files.
      const result = await _x.execute({ _module: "server-xvm", _op: "list-apps", _params: { _include_system: true } });
      const ids = result?._result?._app_ids;
      if (result?._ok !== true || !isDeepStrictEqual(ids, saved ? [saved.app] : [])) return fail("E_ADK_HOST_RESOURCE_CONFLICT");
      if (saved) {
        const params = { _app_id: saved.app, _env: "default" };
        const app = await _x.execute({ _module: "server-xvm", _op: "get-app", _params: params });
        const value = app?._result;
        if (app?._ok !== true || value?._app?._app_id !== saved.app || value?._app?._env !== "default" || value?._app?._system !== true ||
            value?._app?._meta?._entry_view_id !== saved.viewId || !isDeepStrictEqual(value?._view_ids, [saved.viewId]) ||
            !isDeepStrictEqual(value?._flow_ids, []) || !isDeepStrictEqual(value?._entity_ids, [])) return fail("E_ADK_HOST_RESOURCE");
        const view = await _x.execute({ _module: "server-xvm", _op: "get-view", _params: { ...params, _view_id: saved.viewId } });
        if (view?._ok !== true || !isDeepStrictEqual(view?._result?._view, saved.view)) return fail("E_ADK_HOST_RESOURCE");
      }
      state = "ready";
    }),
    async close() {
      // No open handles survive preflight. Retain owned instance files for inspection;
      // never recursively remove an operator path or unregister unrelated entities.
      saved = undefined; parents = []; state = "closed";
    },
  });
}
