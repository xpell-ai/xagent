import assert from "node:assert/strict";
import test from "node:test";

test("the public package entry point is importable", async () => {
  const entry = await import("@xpell/agent");

  assert.equal(typeof entry, "object");
  assert.equal(typeof entry.XAgent, "function");
  assert.equal(typeof entry.XAgentChannelError, "function");
  assert.equal(
    entry.XAGENT_CHANNEL_ERROR_CODES.NOT_FOUND,
    "E_AGENT_CHANNEL_NOT_FOUND",
  );
});
