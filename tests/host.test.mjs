import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

for (const mode of ["zero", "view", "config", "snapshot-config", "snapshot-files", "source-change-during-read",
  "paths", "symlinks", "digest", "collision", "extra-files", "bounds", "invalid-json", "invalid-view",
  "existing", "foreign", "competing", "legacy-competing", "close-before", "close-preflight", "close-node-start",
  "close-verify", "failed-listen", "failed-verify", "failed-start", "failed-cleanup", "drain", "terminal",
  "source-work-overlap", "parent-symlink", "source-directory-symlink", "hardlink", "directory-bound",
  "oversize-total", "partial-materialize", "failed-node-partial", "foreign-after-preflight", "source-inode-overlap", "startup-cleanup-failure"]) {
  test(`Experimental Host: ${mode}`, () => {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("./host-scenario.mjs", import.meta.url)), mode], {
      encoding: "utf8", timeout: 30000, cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C", NODE_ENV: "test", NODE_OPTIONS: process.env.NODE_OPTIONS },
    });
    assert.equal(child.status, 0, `${mode}: ${child.error?.message ?? ""}\n${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /HOST_PASS/);
  });
}
