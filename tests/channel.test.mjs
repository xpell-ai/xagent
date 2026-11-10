import assert from "node:assert/strict";
import test from "node:test";

import {
  XAgent,
  XAGENT_CHANNEL_ERROR_CODES,
} from "@xpell/agent";
import { _x } from "@xpell/node";

import { FakeChannel } from "./fake-channel.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withRuntimeAgent(agent, run) {
  const previous = _x._modules[agent._name];
  delete _x._modules[agent._name];
  try {
    await _x.loadModuleAsync(agent);
    return await run();
  } finally {
    delete _x._modules[agent._name];
    if (previous !== undefined) _x._modules[agent._name] = previous;
  }
}

test("an Agent with zero Channels loads normally", async () => {
  const agent = new XAgent({ _name: "zero-channel-agent" });
  await agent.load();

  assert.deepEqual(agent.listChannels(), []);
  assert.equal(agent.getStatus()._status, "ready");
  assert.equal(agent.getStatus()._ready, true);
});

test("construction and pre-load registration own Channels by unique ID", () => {
  const first = new FakeChannel({ id: "customers", provider: "telegram" });
  const second = new FakeChannel({ id: "owner", provider: "telegram" });
  const agent = new XAgent({
    _name: "registration-agent",
    _channels: [first],
  });

  agent.registerChannel(second);

  assert.deepEqual(agent.listChannels(), [
    {
      _id: "customers",
      _provider: "telegram",
      _status: "registered",
      _ready: false,
    },
    {
      _id: "owner",
      _provider: "telegram",
      _status: "registered",
      _ready: false,
    },
  ]);
});

test("duplicate Channel IDs fail while duplicate provider IDs are allowed", () => {
  assert.throws(
    () =>
      new XAgent({
        _name: "duplicate-channel-agent",
        _channels: [
          new FakeChannel({ id: "same", provider: "fake" }),
          new FakeChannel({ id: "same", provider: "other" }),
        ],
      }),
    (error) => {
      assert.equal(error?._code, XAGENT_CHANNEL_ERROR_CODES.DUPLICATE);
      return true;
    },
  );

  assert.doesNotThrow(
    () =>
      new XAgent({
        _name: "same-provider-agent",
        _channels: [
          new FakeChannel({ id: "first", provider: "fake" }),
          new FakeChannel({ id: "second", provider: "fake" }),
        ],
      }),
  );
});

test("one Channel instance cannot belong to two Agents", () => {
  const channel = new FakeChannel({ id: "owned-once" });
  new XAgent({ _name: "first-owner-agent", _channels: [channel] });

  assert.throws(
    () => new XAgent({ _name: "second-owner-agent", _channels: [channel] }),
    (error) => {
      assert.equal(error?._code, XAGENT_CHANNEL_ERROR_CODES.INVALID);
      return true;
    },
  );
});

test("registration rejects as soon as Agent loading begins", async () => {
  const gate = deferred();
  const starting = new FakeChannel({
    id: "slow-channel",
    startGate: gate.promise,
  });
  const agent = new XAgent({
    _name: "locked-registration-agent",
    _channels: [starting],
  });

  const loading = agent.load();
  assert.throws(
    () => agent.registerChannel(new FakeChannel({ id: "too-late" })),
    (error) => {
      assert.equal(error?._code, XAGENT_CHANNEL_ERROR_CODES.INVALID);
      return true;
    },
  );

  gate.resolve();
  await loading;
});

test("Channel lifecycle is registered to starting to ready and stop is idempotent", async () => {
  const gate = deferred();
  const channel = new FakeChannel({
    id: "lifecycle-channel",
    startGate: gate.promise,
  });
  const agent = new XAgent({
    _name: "lifecycle-agent",
    _channels: [channel],
  });

  assert.equal(agent.listChannels()[0]._status, "registered");
  const loading = agent.load();
  assert.equal(agent.listChannels()[0]._status, "starting");
  gate.resolve();
  await loading;
  assert.equal(agent.listChannels()[0]._status, "ready");
  assert.deepEqual(channel.lifecycle.slice(0, 3), [
    "registered",
    "starting",
    "ready",
  ]);

  await agent.stopChannels();
  await agent.stopChannels();
  assert.equal(agent.listChannels()[0]._status, "stopped");
  assert.equal(channel.stopCount, 1);
});

test("one failed Channel does not block another Channel or Agent readiness", async () => {
  const failed = new FakeChannel({ id: "failed-channel", failStart: true });
  const ready = new FakeChannel({ id: "ready-channel" });
  const agent = new XAgent({
    _name: "isolated-start-agent",
    _channels: [failed, ready],
  });

  await agent.load();

  assert.equal(agent.getStatus()._ready, true);
  assert.equal(failed.getStatus()._status, "not_ready");
  assert.equal(ready.getStatus()._status, "ready");
  assert.deepEqual(agent.listChannels(), [
    {
      _id: "failed-channel",
      _provider: "fake",
      _status: "not_ready",
      _ready: false,
      _error: {
        _code: XAGENT_CHANNEL_ERROR_CODES.NOT_READY,
        _message: "Channel failed to start",
      },
    },
    {
      _id: "ready-channel",
      _provider: "fake",
      _status: "ready",
      _ready: true,
    },
  ]);
});

test("list-channels executes through the Agent operation", async () => {
  const channel = new FakeChannel({ id: "listed-channel", provider: "web" });
  const agent = new XAgent({
    _name: "list-channels-agent",
    _channels: [channel],
  });

  await withRuntimeAgent(agent, async () => {
    const response = await _x.execute({
      _module: agent._name,
      _op: "list-channels",
      _params: {},
    });

    assert.equal(response._ok, true);
    assert.deepEqual(response._result._channels, [
      {
        _id: "listed-channel",
        _provider: "web",
        _status: "ready",
        _ready: true,
      },
    ]);
  });
});

test("FakeChannel ingress crosses bound _x.execute and replies through the same Channel", async () => {
  const received = [];
  class GreetingAgent extends XAgent {
    async onMessage(message) {
      received.push({ ...message });
      if (message._text !== "hello") return undefined;
      return {
        _external_conversation_id: message._external_conversation_id,
        _text: "hi",
        _reply_to_external_message_id: message._external_message_id,
      };
    }
  }

  const channel = new FakeChannel({ id: "inbound-channel", provider: "fake" });
  const other = new FakeChannel({ id: "other-channel", provider: "fake" });
  const agent = new GreetingAgent({
    _name: "greeting-agent",
    _channels: [channel, other],
  });

  await withRuntimeAgent(agent, async () => {
    const originalExecute = _x.execute;
    const executions = [];
    _x.execute = function (command) {
      executions.push(command);
      return originalExecute.call(this, command);
    };

    try {
      const response = await channel.inject({
        _channel_id: "other-channel",
        _external_user_id: "external-user-7",
        _external_conversation_id: "external-conversation-8",
        _external_message_id: "external-message-9",
        _text: "hello",
        _timestamp: 1_700_000_123_456,
        _reply_to_external_message_id: "external-message-previous",
      });

      assert.equal(executions.length, 1);
      assert.equal(executions[0]._module, "greeting-agent");
      assert.equal(executions[0]._op, "receive-message");
      assert.equal(executions[0]._params._channel_id, "inbound-channel");
      assert.deepEqual(received, [
        {
          _channel_id: "inbound-channel",
          _external_user_id: "external-user-7",
          _external_conversation_id: "external-conversation-8",
          _external_message_id: "external-message-9",
          _text: "hello",
          _timestamp: 1_700_000_123_456,
          _reply_to_external_message_id: "external-message-previous",
        },
      ]);
      assert.deepEqual(channel.outbound, [
        {
          _external_conversation_id: "external-conversation-8",
          _text: "hi",
          _reply_to_external_message_id: "external-message-9",
        },
      ]);
      assert.deepEqual(other.outbound, []);
      assert.equal(response._ok, true);
      assert.deepEqual(response._result, {
        _accepted: true,
        _external_message_id: "inbound-channel-out-1",
        _accepted_at: 1_700_000_000_001,
      });
    } finally {
      _x.execute = originalExecute;
    }
  });
});

test("default no-response behavior performs no outbound send", async () => {
  const channel = new FakeChannel({ id: "silent-channel" });
  const agent = new XAgent({
    _name: "silent-agent",
    _channels: [channel],
  });

  await withRuntimeAgent(agent, async () => {
    const response = await channel.inject({
      _external_user_id: "user",
      _external_conversation_id: "conversation",
      _external_message_id: "message",
      _text: "hello",
    });

    assert.equal(response._ok, true);
    assert.equal(response._result, null);
    assert.deepEqual(channel.outbound, []);
  });
});

test("send-message selects the exact Channel and returns provider acceptance", async () => {
  const first = new FakeChannel({ id: "send-first" });
  const second = new FakeChannel({ id: "send-second" });
  const agent = new XAgent({
    _name: "send-selection-agent",
    _channels: [first, second],
  });

  await withRuntimeAgent(agent, async () => {
    const response = await _x.execute({
      _module: agent._name,
      _op: "send-message",
      _params: {
        _channel_id: "send-second",
        _external_conversation_id: "conversation-22",
        _text: "outbound",
        _reply_to_external_message_id: "message-21",
      },
    });

    assert.equal(response._ok, true);
    assert.deepEqual(first.outbound, []);
    assert.deepEqual(second.outbound, [
      {
        _external_conversation_id: "conversation-22",
        _text: "outbound",
        _reply_to_external_message_id: "message-21",
      },
    ]);
    assert.equal(response._result._accepted, true);
    assert.equal(response._result._external_message_id, "send-second-out-1");
  });
});

test("unknown and not-ready Channels return structured errors", async () => {
  const failed = new FakeChannel({ id: "not-ready-channel", failStart: true });
  const agent = new XAgent({
    _name: "channel-errors-agent",
    _channels: [failed],
  });

  await withRuntimeAgent(agent, async () => {
    const unknown = await _x.execute({
      _module: agent._name,
      _op: "send-message",
      _params: {
        _channel_id: "missing-channel",
        _external_conversation_id: "conversation",
        _text: "hello",
      },
    });
    const notReady = await _x.execute({
      _module: agent._name,
      _op: "send-message",
      _params: {
        _channel_id: "not-ready-channel",
        _external_conversation_id: "conversation",
        _text: "hello",
      },
    });

    assert.equal(unknown._ok, false);
    assert.equal(unknown._result._code, XAGENT_CHANNEL_ERROR_CODES.NOT_FOUND);
    assert.equal(notReady._ok, false);
    assert.equal(notReady._result._code, XAGENT_CHANNEL_ERROR_CODES.NOT_READY);
  });
});

test("provider send failures are structured and redact provider details", async () => {
  const channel = new FakeChannel({ id: "send-failure", failSend: true });
  const agent = new XAgent({
    _name: "provider-failure-agent",
    _channels: [channel],
  });

  await withRuntimeAgent(agent, async () => {
    const response = await _x.execute({
      _module: agent._name,
      _op: "send-message",
      _params: {
        _channel_id: "send-failure",
        _external_conversation_id: "conversation",
        _text: "hello",
      },
    });

    assert.equal(response._ok, false);
    assert.equal(response._result._code, XAGENT_CHANNEL_ERROR_CODES.SEND_FAILED);
    assert.equal(JSON.stringify(response).includes("fake-provider-secret"), false);
    assert.deepEqual(response._result._meta, {
      _channel_id: "send-failure",
      _provider: "fake",
    });
  });
});

test("bad inbound messages and handler failures return structured errors", async () => {
  class BrokenAgent extends XAgent {
    async onMessage() {
      throw new Error("private-handler-details");
    }
  }

  const channel = new FakeChannel({ id: "handler-channel" });
  const agent = new BrokenAgent({
    _name: "handler-errors-agent",
    _channels: [channel],
  });

  await withRuntimeAgent(agent, async () => {
    const bad = await channel.inject({
      _external_user_id: "user",
      _external_conversation_id: "conversation",
      _external_message_id: "message",
      _text: "",
    });
    const failed = await channel.inject({
      _external_user_id: "user",
      _external_conversation_id: "conversation",
      _external_message_id: "message",
      _text: "hello",
    });

    assert.equal(bad._ok, false);
    assert.equal(bad._result._code, XAGENT_CHANNEL_ERROR_CODES.BAD_MESSAGE);
    assert.equal(failed._ok, false);
    assert.equal(
      failed._result._code,
      XAGENT_CHANNEL_ERROR_CODES.MESSAGE_HANDLER_FAILED,
    );
    assert.equal(JSON.stringify(failed).includes("private-handler-details"), false);
  });
});
