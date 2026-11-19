import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineReferenceAgent } from "../dist/agent.js";

test("pinned artifact and public T1-T4 exports are available", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const archive = await readFile(new URL("../artifacts/xpell-agent-2.0.8.tgz", import.meta.url));
  assert.equal(createHash("sha256").update(archive).digest("hex"), manifest.xpellReferenceArtifact.sha256);
  const installed = JSON.parse(await readFile(new URL(import.meta.resolve("@xpell/agent/package.json")), "utf8"));
  assert.equal(installed.version, "2.0.8");
  assert.equal(installed.peerDependencies["@xpell/node"], manifest.xpellReferenceArtifact.requiredNodePeer);
  for (const [entry, name] of [
    ["@xpell/agent/adk", "createAgent"],
    ["@xpell/agent/adk/tools", "createToolRegistry"],
    ["@xpell/agent/adk/actions", "createDurableActions"],
    ["@xpell/agent/adk/tool-loop", "createRouterToolLoop"],
    ["@xpell/agent/adk/plugins", "createAgentPluginRegistry"],
  ]) assert.equal(typeof (await import(entry))[name], "function", entry);
});

test("public mock turn, status and terminal close", async () => {
  const parent = await mkdtemp(join(tmpdir(), "xagent-reference-test-"));
  const app = defineReferenceAgent(join(parent, "runtime"));
  try {
    assert.equal(app.getStatus()._state, "created");
    await app.start();
    assert.equal(app.getStatus()._state, "ready");
    assert.equal(app.getStatus()._channels[0]._provider, "mock");
    assert.equal(await app.testTurn({ _text: "hello" }), "Hello from the reference agent");
    await app.close();
    assert.equal(app.getStatus()._state, "closed");
    await assert.rejects(app.testTurn({ _text: "after close" }), { _code: "E_ADK_NOT_READY" });
    await assert.rejects(app.start(), { _code: "E_ADK_CLOSED" });
  } finally {
    try { await app.close(); }
    finally { await rm(parent, { recursive: true, force: true }); }
  }
});

test("optional Read/plugin composition stays denied without grants or policy", async () => {
  const { defineTool, createToolRegistry } = await import("@xpell/agent/adk/tools");
  const { defineAgentPlugin, createAgentPluginRegistry } = await import("@xpell/agent/adk/plugins");
  let calls = 0;
  const plugin = defineAgentPlugin({
    _id: "reference-read", _version: "1.0.0", _contract: 1,
    _peers: { "@xpell/agent": "2.0.8" }, _dependencies: [],
    _permissions: { _host: ["sample.resource"], _agent: ["sample.read"] },
    _tools: [defineTool({
      _id: "sample.echo", _description: "Neutral read fixture",
      _effect: "read", _confirmation: "none",
      _input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
      _handler: () => { calls++; return { text: "fixture" }; },
    })],
  });
  const plugins = createAgentPluginRegistry({ _peers: { "@xpell/agent": "2.0.8" } });
  plugins.register(plugin);
  const reads = createToolRegistry({
    _tools: plugins.getContributions()._tools, _policy: plugins.readPolicy(),
    _limits: { _timeout_ms: 1000, _max_input_bytes: 256, _max_output_bytes: 256,
      _max_invocations: 4, _max_contexts: 2 },
  });
  const context = reads.bindContext({
    _instance_id: "reference", _application_scope: { _env: "test", _app_id: "reference" },
    _actor_id: "synthetic-actor", _conversation_id: "conversation", _delivery_id: "delivery",
  });
  try {
    await plugins.start();
    assert.equal(plugins.isAvailable("reference-read"), false);
    assert.deepEqual(await reads.project(context), []);
    await assert.rejects(reads.invoke({ _id: "one", _name: "sample.echo", _arguments: {} }, context),
      { _code: "E_ADK_TOOL_DENIED" });
    assert.equal(calls, 0);
  } finally {
    reads.close();
    await plugins.dispose();
  }
});

test("compiled entrypoint completes one mock turn and exits", () => {
  const output = execFileSync(process.execPath,
    [fileURLToPath(new URL("../dist/main.js", import.meta.url))], {
      encoding: "utf8", timeout: 20000,
      env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: process.env.NODE_OPTIONS ?? "" },
    });
  assert.match(output, /Hello from the reference agent/);
});
