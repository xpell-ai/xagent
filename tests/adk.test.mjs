import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Each real XNode lifecycle is terminal and requires its own process.
for (const scenario of ["hello", "zero-plugins", "close-before-start", "close-during-start",
  "close-during-node-start", "failed-listen", "existing-folder", "competing-hosts",
  "foreign-host", "terminal-host", "drain-turn", "config"]) {
  test(`ADK Foundation: ${scenario}`, () => {
    const child = spawnSync(process.execPath,
      [fileURLToPath(new URL("./adk-scenario.mjs", import.meta.url)), scenario], {
        encoding: "utf8", timeout: 30_000,
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C", NODE_ENV: "test" },
      });
    assert.equal(child.status, 0,
      `${scenario}: ${child.error?.message ?? ""}\n${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /ADK_SCENARIO_PASS/);
  });
}
