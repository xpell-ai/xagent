import assert from "node:assert/strict";
import test from "node:test";

import {
  XAgent,
  XAGENT_OPS,
  XAGENT_SKILL,
} from "@xpell/agent";
import { XModule, XpellEngine } from "@xpell/node";

test("XAgent uses its module name as stable runtime identity", () => {
  const agent = new XAgent({
    _name: "centrum",
    _description: "Centrum runtime agent",
    _version: "0.1.0",
  });

  assert.ok(agent instanceof XModule);
  assert.equal(agent._name, "centrum");
  assert.deepEqual(agent.getStatus(), {
    _name: "centrum",
    _description: "Centrum runtime agent",
    _version: "0.1.0",
    _status: "created",
    _ready: false,
  });
  assert.equal(XAgent._ops, XAGENT_OPS);
  assert.equal(XAgent._skill, XAGENT_SKILL);
  assert.equal(XAgent._skill._runtime._target, "server");
  assert.equal(XAgent._skill._runtime._hosts[0], "xnode");
});

test("XAgent rejects invalid runtime identities", () => {
  for (const name of ["", "Centrum", "centrum agent", "centrum_agent", "-centrum", "centrum-"]) {
    assert.throws(
      () => new XAgent({ _name: name }),
      /lowercase kebab-case agent identity|Invalid '_name'/,
    );
  }
});

test("XAgent lifecycle follows XModule loading state", async () => {
  let releaseLoad;
  let loadCount = 0;
  const loadingGate = new Promise((resolve) => {
    releaseLoad = resolve;
  });

  class DeferredAgent extends XAgent {
    async onLoad() {
      loadCount += 1;
      await loadingGate;
    }
  }

  const agent = new DeferredAgent({ _name: "deferred-agent" });
  assert.equal(agent.getStatus()._status, "created");

  const loading = agent.load();
  assert.deepEqual(agent.getStatus(), {
    _name: "deferred-agent",
    _status: "starting",
    _ready: false,
  });

  releaseLoad();
  await loading;

  assert.deepEqual(agent.getStatus(), {
    _name: "deferred-agent",
    _status: "ready",
    _ready: true,
  });

  await agent.load();
  assert.equal(loadCount, 1);
});

test("status executes through the normal Xpell command path", async () => {
  const runtime = new XpellEngine({ _schedule_frame: () => {} });
  const agent = new XAgent({ _name: "status-agent" });

  await runtime.loadModuleAsync(agent);

  const response = await runtime.execute({
    _module: "status-agent",
    _op: "status",
    _params: {},
  });

  assert.equal(response._ok, true);
  assert.deepEqual(response._result, {
    _name: "status-agent",
    _status: "ready",
    _ready: true,
  });

  const skillModule = runtime
    .getSkills()
    ._modules.find((module) => module._name === "status-agent");

  assert.ok(skillModule);
  assert.equal(
    skillModule._skills[0]._exports._modules[0]._name,
    "status-agent",
  );
  assert.deepEqual(
    skillModule._skills[0]._exports._modules[0]._ops.map((op) => op._name),
    ["status", "list-channels", "receive-message", "send-message"],
  );
});
