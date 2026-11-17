import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";

import { XAgent } from "@xpell/agent";
import { XModule, XNode, _x } from "@xpell/node";

const consumer = createRequire(import.meta.url);
const agentManifestPath = consumer.resolve("@xpell/agent/package.json");
const agent = createRequire(agentManifestPath);

test("XNode remains a required runtime peer of the Agent package", async () => {
  const manifest = JSON.parse(await readFile(agentManifestPath, "utf8"));
  assert.equal(typeof manifest.peerDependencies?.["@xpell/node"], "string");
  assert.notEqual(manifest.peerDependencies["@xpell/node"].trim(), "");
  assert.notEqual(manifest.peerDependenciesMeta?.["@xpell/node"]?.optional, true);
});

test("Agent and consumer share the XNode peer and its ESM Core", async () => {
  const nodePath = agent.resolve("@xpell/node");
  assert.equal(await realpath(nodePath), await realpath(consumer.resolve("@xpell/node")));
  const node = createRequire(nodePath);
  const coreManifestPath = node.resolve("@xpell/core/package.json");
  const coreManifest = JSON.parse(await readFile(coreManifestPath, "utf8"));
  // Core has separate import/require entries. Use its ESM entry, and resolve
  // through our declared Node peer instead of requiring a new direct Core peer.
  const corePath = path.resolve(path.dirname(coreManifestPath), coreManifest.exports["."].import);
  const peerNode = await import(pathToFileURL(nodePath).href);
  const core = await import(pathToFileURL(corePath).href);
  assert.equal(peerNode.XNode, XNode);
  assert.equal(peerNode._x, _x);
  assert.equal(peerNode._x, core._x);
  assert.equal(peerNode.XModule, core.XModule);
  assert.ok(new XAgent({ _name: "peer-consumer" }) instanceof XModule);
});

test("Agent keeps its ESM-only entry boundary", () => {
  assert.throws(() => consumer("@xpell/agent"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
});
