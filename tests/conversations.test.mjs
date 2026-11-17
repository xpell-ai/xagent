import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("./conversations-scenario.mjs", import.meta.url));
function run(scenario, parent, extra = []) {
  const r = spawnSync(process.execPath, [worker, scenario, parent, ...extra], {
    encoding: "utf8", timeout: 30_000,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C", NODE_ENV: "test" },
  });
  if (scenario === "crash") {
    assert.equal(r.signal, "SIGKILL", `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /CRASH_AFTER_DURABLE_SENDING/);
  } else {
    assert.equal(r.status, 0, `${scenario}: ${r.error?.message ?? ""}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /CONVERSATIONS_PASS/);
  }
}
for (const scenario of ["restart", "scope", "crash", "isolation", "bounds", "filtered-history", "config",
  "unknown-folder", "symlink", "failed-listen", "partial-start", "close-during-start", "close-before-start", "foreign-host", "drain"]) {
  test(`Durable conversations: ${scenario}`, async () => {
    const parent = await mkdtemp(join(tmpdir(), "xagent-durable-test-"));
    try {
      if (scenario === "restart") { run("write", parent); run("read", parent); }
      else if (scenario === "scope") { run("write", parent); run("mismatch", parent); run("read", parent); run("other-scope", parent); }
      else if (scenario === "crash") { run("crash", parent); run("recover", parent); }
      else run(scenario, parent);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
}
