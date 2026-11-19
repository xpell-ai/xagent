import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

function run(mode) {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./host-turn-scenario.mjs", import.meta.url)), mode], {
    encoding: "utf8", timeout: 30000, cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C", NODE_ENV: "test", NODE_OPTIONS: process.env.NODE_OPTIONS },
  });
  assert.equal(child.status, 0, `${mode}: ${child.error?.message ?? ""}\n${child.stdout}\n${child.stderr}`);
  const marker = child.stdout.split("\n").find(line => line.startsWith("HOST_TURN_PASS "));
  assert.ok(marker); return JSON.parse(marker.slice("HOST_TURN_PASS ".length));
}
for (const mode of ["view", "legacy", "config", "snapshot", "input", "signal", "input-limit", "output-limit", "output-type",
  "run-denied", "reply-denied", "read-denied", "actor", "forged", "revoke-invoke", "revoke-reply", "revoke-host", "replay", "conflict",
  "arguments", "batch", "unknown", "timeout", "cancel", "close-active", "cancel-run-policy", "cancel-reply-policy",
  "raw-error", "getter-error", "proxy-error", "unsafe-code", "rogue", "duplicate-ingress", "competing", "foreign", "close-before"]) {
  test(`Trusted Host turn: ${mode}`, () => { run(mode); });
}
test("Trusted Host model grounds its answer in changed tool data", () => {
  const first = run("hours-a"), second = run("hours-b");
  assert.deepEqual(first.evidence.model_inputs[0], second.evidence.model_inputs[0]);
  assert.notEqual(first.answer, second.answer); assert.equal(first.evidence.handlers, 1); assert.equal(second.evidence.handlers, 1);
});
