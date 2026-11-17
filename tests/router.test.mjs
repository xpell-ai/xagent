import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const worker = fileURLToPath(new URL("./router-scenario.mjs", import.meta.url));
for (const scenario of ["restart", "context", "wrong-key", "auth-omission", "timeout", "routing-error", "metering-error",
  "non-json", "malformed", "missing-result", "planning", "truncated", "tools", "config", "credential", "failed-start", "drain", "cli-gate"]) {
  test(`Router chat: ${scenario}`, async () => {
    const parent = await mkdtemp(join(tmpdir(), "xagent-router-test-"));
    try {
      for (const part of scenario === "restart" ? ["write", "read"] : [scenario]) {
        const child = spawnSync(process.execPath, [worker, part, parent], {
          encoding: "utf8", timeout: 30000,
          env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C", NODE_ENV: "test" },
        });
        assert.equal(child.status, 0, `${part}: ${child.error?.message ?? ""}\n${child.stdout}\n${child.stderr}`);
        assert.match(child.stdout, /ROUTER_SCENARIO_PASS/);
        assert.equal((child.stdout + child.stderr).includes("RAW_PROVIDER_SECRET_DO_NOT_LEAK"), false);
        assert.equal((child.stdout + child.stderr).includes("offline-fixture-key"), false);
      }
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
}
