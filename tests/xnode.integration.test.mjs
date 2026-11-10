import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { XAgent } from "@xpell/agent";
import {
  Settings,
  XModule,
  XNode,
  XResponseOK,
  _x,
} from "@xpell/node";

const AGENT_NAME = "xagent-v01-test";
const EXISTING_MODULE_NAME = "xagent-existing-test";

class ExistingRuntimeModule extends XModule {
  constructor() {
    super({ _name: EXISTING_MODULE_NAME });
  }

  _health() {
    return new XResponseOK({ _status: "ok" }).toXData();
  }
}

function createFakeWebServer() {
  return {
    onSetup() {},
    init() {},
    load() {},
    useRoutes() {},
    async start() {},
  };
}

test("XNode loads XAgent and both modules remain executable", async () => {
  const workFolder = await mkdtemp(path.join(tmpdir(), "xagent-xnode-"));
  const agent = new XAgent({ _name: AGENT_NAME });
  const existingModule = new ExistingRuntimeModule();
  const node = new XNode();
  node._web_server = createFakeWebServer();

  const originalStart = _x.start;
  const originalLoadModuleAsync = _x.loadModuleAsync;
  const runtimeModules = _x._modules;
  const previousAgent = runtimeModules[AGENT_NAME];
  const previousExisting = runtimeModules[EXISTING_MODULE_NAME];
  const loadedModules = [];

  delete runtimeModules[AGENT_NAME];
  delete runtimeModules[EXISTING_MODULE_NAME];

  _x.start = () => {};
  _x.loadModuleAsync = async (module) => {
    loadedModules.push(module._name);

    if (module === agent || module === existingModule) {
      await originalLoadModuleAsync.call(_x, module);
    }
  };

  try {
    await node.start({
      _work_folder: workFolder,
      _modules: [agent, existingModule],
    });

    const agentStatus = await _x.execute({
      _module: AGENT_NAME,
      _op: "status",
      _params: {},
    });
    const existingHealth = await _x.execute({
      _module: EXISTING_MODULE_NAME,
      _op: "health",
      _params: {},
    });

    assert.equal(node._started, true);
    assert.equal(agentStatus._ok, true);
    assert.equal(agentStatus._result._status, "ready");
    assert.equal(agentStatus._result._ready, true);
    assert.deepEqual(existingHealth._result, { _status: "ok" });
    assert.ok(loadedModules.includes("ping"));
    assert.ok(loadedModules.includes("flow"));
    assert.ok(loadedModules.includes("server-xvm"));
    assert.ok(loadedModules.indexOf(AGENT_NAME) < loadedModules.indexOf("flow"));
    assert.ok(loadedModules.indexOf(EXISTING_MODULE_NAME) < loadedModules.indexOf("flow"));
  } finally {
    _x.start = originalStart;
    _x.loadModuleAsync = originalLoadModuleAsync;

    delete runtimeModules[AGENT_NAME];
    delete runtimeModules[EXISTING_MODULE_NAME];
    if (previousAgent !== undefined) runtimeModules[AGENT_NAME] = previousAgent;
    if (previousExisting !== undefined) runtimeModules[EXISTING_MODULE_NAME] = previousExisting;

    Settings.close();
    await rm(workFolder, { recursive: true, force: true });
  }
});

test("XNode rejects duplicate agent module identities before loading", async () => {
  const node = new XNode();

  await assert.rejects(
    () =>
      node.start({
        _modules: [
          new XAgent({ _name: "duplicate-agent" }),
          new XAgent({ _name: "duplicate-agent" }),
        ],
      }),
    (error) => {
      assert.equal(error?._code, "E_XNODE_DUPLICATE_MODULES");
      assert.deepEqual(error?._details?._duplicates, ["duplicate-agent"]);
      return true;
    },
  );
});
