import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("./actions-scenario.mjs", import.meta.url));
function run(scenario, parent, stage = "") {
  const r = spawnSync(process.execPath, [worker, scenario, parent, stage], {
    encoding: "utf8", timeout: 30_000,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: process.env.NODE_OPTIONS, LANG: "C", NODE_ENV: "test" },
  });
  assert.doesNotMatch(r.stdout + r.stderr, /SYNTHETIC_UNSAFE_EXCEPTION/);
  if (scenario === "crash") {
    assert.equal(r.signal, "SIGKILL", r.stdout + r.stderr);
    assert.match(r.stdout, /ACTION_CRASH/);
  } else {
    assert.equal(r.status, 0, `${scenario}/${stage}: ${r.error?.message ?? ""}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /ACTIONS_PASS/);
  }
}
for (const scenario of ["lifecycle", "deny", "authority", "validation", "changed-preparation", "expiry", "execute-denial",
  "execute-expiry", "concurrency", "cancel-race", "uncertain", "invalid-result", "timeout", "reconcile-busy", "pagination",
  "completion-failure", "reconcile-race", "known-failure", "tamper", "profile", "symlink", "failed-start", "partial-start", "foreign-host", "drain", "config"]) {
  test(`Durable Actions: ${scenario}`, async () => {
    const parent = await mkdtemp(join(tmpdir(), "xagent-actions-test-"));
    try { run(scenario, parent); } finally { await rm(parent, { recursive: true, force: true }); }
  });
}
for (const stage of ["prepared", "confirmed", "claimed", "before-handler", "effect", "completed"]) {
  test(`Durable Actions: process crash/restart after ${stage}`, async () => {
    const parent = await mkdtemp(join(tmpdir(), "xagent-action-crash-"));
    try { run("crash", parent, stage); run("recover", parent, stage); run("replay", parent, stage); }
    finally { await rm(parent, { recursive: true, force: true }); }
  });
}
for (const scenario of ["revision", "revision-pending", "missing-definition", "wrong-evidence", "restart-policy", "scope-marker"]) {
  test(`Durable Actions: restart ${scenario}`, async () => {
    const parent = await mkdtemp(join(tmpdir(), "xagent-action-restart-"));
    try { run(scenario === "revision-pending" ? "seed-pending" : "seed", parent); run(scenario, parent); }
    finally { await rm(parent, { recursive: true, force: true }); }
  });
}
