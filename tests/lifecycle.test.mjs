import assert from "node:assert/strict";
import test from "node:test";

import { XAgent, XAGENT_CHANNEL_ERROR_CODES, XChannelSendFailure } from "@xpell/agent";
import { _x } from "@xpell/node";

import { FakeChannel } from "./fake-channel.mjs";

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

function inbound(text = "hello") {
  return {
    _external_user_id: "external-user",
    _external_conversation_id: "external-conversation",
    _external_message_id: "external-message",
    _text: text,
  };
}

function explicitSend(agent, text = "hello") {
  return _x.execute({
    _module: agent._name,
    _op: "send-message",
    _params: {
      _channel_id: "lifecycle-channel",
      _external_conversation_id: "external-conversation",
      _text: text,
    },
  });
}

test("inbound lifecycle surrounds no-response behavior in deterministic order", async () => {
  const events = [];
  const contexts = [];
  const lifecycle = {
    beforeInbound(context, message) {
      events.push("before-inbound");
      contexts.push(context);
      assert.equal(context._origin, "inbound");
      assert.equal(Object.isFrozen(context), true);
      assert.equal(Object.isFrozen(message), true);
    },
    afterInbound(context, message, outcome) {
      events.push(`after-inbound:${outcome._status}`);
      contexts.push(context);
      assert.equal(Object.isFrozen(message), true);
      assert.equal(Object.isFrozen(outcome), true);
    },
    beforeSend() {
      events.push("unexpected-before-send");
    },
  };

  class SilentAgent extends XAgent {
    async onMessage(_message, context) {
      events.push("on-message");
      contexts.push(context);
      return undefined;
    }
  }

  const channel = new FakeChannel({ id: "lifecycle-channel" });
  const agent = new SilentAgent({
    _name: "inbound-lifecycle-agent",
    _channels: [channel],
    _message_lifecycle: lifecycle,
  });

  await withRuntimeAgent(agent, async () => {
    const response = await channel.inject(inbound());

    assert.equal(response._ok, true);
    assert.equal(response._result, null);
    assert.deepEqual(events, [
      "before-inbound",
      "on-message",
      "after-inbound:processed",
    ]);
    assert.ok(contexts.every((context) => context === contexts[0]));
    assert.deepEqual(channel.outbound, []);
  });
});

test("automatic response uses the same context and canonical send lifecycle", async () => {
  const events = [];
  const contexts = [];
  const lifecycle = {
    beforeInbound(context) {
      events.push("before-inbound");
      contexts.push(context);
    },
    afterInbound(context, _message, outcome) {
      events.push(`after-inbound:${outcome._status}`);
      contexts.push(context);
    },
    beforeSend(context, message) {
      events.push("before-send");
      contexts.push(context);
      assert.equal(message._channel_id, "lifecycle-channel");
      assert.equal(Object.isFrozen(message), true);
    },
    afterSend(context, _message, outcome) {
      events.push(`after-send:${outcome._status}`);
      contexts.push(context);
      assert.equal(outcome._status, "accepted");
      assert.equal(Object.isFrozen(outcome._result), true);
    },
  };

  class ReplyAgent extends XAgent {
    async onMessage(message, context) {
      events.push("on-message");
      contexts.push(context);
      return {
        _external_conversation_id: message._external_conversation_id,
        _text: "hi",
      };
    }
  }

  const channel = new FakeChannel({ id: "lifecycle-channel" });
  const channelSend = channel.send.bind(channel);
  channel.send = async (message) => {
    events.push("channel-send");
    return await channelSend(message);
  };
  const agent = new ReplyAgent({
    _name: "automatic-lifecycle-agent",
    _channels: [channel],
    _message_lifecycle: lifecycle,
  });

  await withRuntimeAgent(agent, async () => {
    const response = await channel.inject(inbound());

    assert.equal(response._ok, true);
    assert.deepEqual(events, [
      "before-inbound",
      "on-message",
      "after-inbound:processed",
      "before-send",
      "channel-send",
      "after-send:accepted",
    ]);
    assert.ok(contexts.every((context) => context === contexts[0]));
    assert.equal(contexts[0]._origin, "inbound");
  });
});

test("handler failures are observed without replacing the safe primary error", async () => {
  const events = [];
  let observedError;
  const lifecycle = {
    beforeInbound() {
      events.push("before-inbound");
    },
    afterInbound(_context, _message, outcome) {
      events.push(`after-inbound:${outcome._status}`);
      observedError = outcome._error;
      throw new Error("private-observer-failure");
    },
  };

  class BrokenAgent extends XAgent {
    async onMessage() {
      events.push("on-message");
      throw new Error("private-handler-failure");
    }
  }

  const channel = new FakeChannel({ id: "lifecycle-channel" });
  const agent = new BrokenAgent({
    _name: "handler-lifecycle-agent",
    _channels: [channel],
    _message_lifecycle: lifecycle,
  });

  await withRuntimeAgent(agent, async () => {
    const response = await channel.inject(inbound());

    assert.deepEqual(events, [
      "before-inbound",
      "on-message",
      "after-inbound:processing_failed",
    ]);
    assert.equal(response._ok, false);
    assert.equal(
      response._result._code,
      XAGENT_CHANNEL_ERROR_CODES.MESSAGE_HANDLER_FAILED,
    );
    assert.equal(
      observedError._code,
      XAGENT_CHANNEL_ERROR_CODES.MESSAGE_HANDLER_FAILED,
    );
    assert.equal(JSON.stringify(response).includes("private-handler-failure"), false);
    assert.equal(JSON.stringify(response).includes("private-observer-failure"), false);
  });
});

test("invalid handler output is observed as a safe processing failure", async () => {
  let outcome;
  class InvalidResultAgent extends XAgent {
    async onMessage() {
      return { _text: "missing conversation" };
    }
  }

  const channel = new FakeChannel({ id: "lifecycle-channel" });
  const agent = new InvalidResultAgent({
    _name: "invalid-result-lifecycle-agent",
    _channels: [channel],
    _message_lifecycle: {
      afterInbound(_context, _message, value) {
        outcome = value;
      },
    },
  });

  await withRuntimeAgent(agent, async () => {
    const response = await channel.inject(inbound());

    assert.equal(response._ok, false);
    assert.equal(
      response._result._code,
      XAGENT_CHANNEL_ERROR_CODES.MESSAGE_HANDLER_FAILED,
    );
    assert.equal(outcome._status, "processing_failed");
    assert.deepEqual(channel.outbound, []);
  });
});

test("handled inbound short-circuits behavior, post-processing, and send", async () => {
  const events = [];
  class ShouldNotRunAgent extends XAgent {
    async onMessage() {
      events.push("on-message");
      return {
        _external_conversation_id: "external-conversation",
        _text: "unexpected",
      };
    }
  }

  const channel = new FakeChannel({ id: "lifecycle-channel" });
  const agent = new ShouldNotRunAgent({
    _name: "handled-lifecycle-agent",
    _channels: [channel],
    _message_lifecycle: {
      beforeInbound() {
        events.push("before-inbound:handled");
        return { _action: "handled" };
      },
      afterInbound() {
        events.push("after-inbound");
      },
      beforeSend() {
        events.push("before-send");
      },
    },
  });

  await withRuntimeAgent(agent, async () => {
    const response = await channel.inject(inbound());

    assert.equal(response._ok, true);
    assert.equal(response._result, null);
    assert.deepEqual(events, ["before-inbound:handled"]);
    assert.deepEqual(channel.outbound, []);
  });
});

test("explicit sends use independent explicit contexts and the canonical lifecycle", async () => {
  const events = [];
  const contexts = [];
  const lifecycle = {
    beforeInbound() {
      events.push("unexpected-before-inbound");
    },
    beforeSend(context, message) {
      events.push(`before-send:${message._text}`);
      contexts.push(context);
      assert.equal(context._origin, "explicit");
    },
    afterSend(context, message, outcome) {
      events.push(`after-send:${message._text}:${outcome._status}`);
      assert.equal(context, contexts.at(-1));
    },
  };

  const channel = new FakeChannel({ id: "lifecycle-channel" });
  const channelSend = channel.send.bind(channel);
  channel.send = async (message) => {
    events.push(`channel-send:${message._text}`);
    return await channelSend(message);
  };
  const agent = new XAgent({
    _name: "explicit-lifecycle-agent",
    _channels: [channel],
    _message_lifecycle: lifecycle,
  });

  await withRuntimeAgent(agent, async () => {
    const first = await explicitSend(agent, "first");
    const second = await explicitSend(agent, "second");

    assert.equal(first._ok, true);
    assert.equal(second._ok, true);
    assert.deepEqual(events, [
      "before-send:first",
      "channel-send:first",
      "after-send:first:accepted",
      "before-send:second",
      "channel-send:second",
      "after-send:second:accepted",
    ]);
    assert.equal(contexts.length, 2);
    assert.notEqual(contexts[0], contexts[1]);
  });
});

test("provider failure is observed and remains authoritative when its observer fails", async () => {
  const events = [];
  let observedError;
  const channel = new FakeChannel({ id: "lifecycle-channel", failSend: true });
  const channelSend = channel.send.bind(channel);
  channel.send = async (message) => {
    events.push("channel-send");
    return await channelSend(message);
  };
  const agent = new XAgent({
    _name: "send-failure-lifecycle-agent",
    _channels: [channel],
    _message_lifecycle: {
      beforeSend() {
        events.push("before-send");
      },
      afterSend(_context, _message, outcome) {
        events.push(`after-send:${outcome._status}`);
        observedError = outcome._error;
        throw new Error("private-send-observer-failure");
      },
    },
  });

  await withRuntimeAgent(agent, async () => {
    const response = await explicitSend(agent);

    assert.deepEqual(events, [
      "before-send",
      "channel-send",
      "after-send:send_failed",
    ]);
    assert.equal(response._ok, false);
    assert.equal(response._result._code, XAGENT_CHANNEL_ERROR_CODES.SEND_FAILED);
    assert.equal(observedError._code, XAGENT_CHANNEL_ERROR_CODES.SEND_FAILED);
    assert.equal(JSON.stringify(response).includes("fake-provider-secret"), false);
    assert.equal(
      JSON.stringify(response).includes("private-send-observer-failure"),
      false,
    );
  });
});

test("the claim gate runs after persistence and blocks Channel send on failure", async () => {
  const events = [];
  const channel = new FakeChannel({ id: "lifecycle-channel" });
  channel.send = async () => { events.push("channel-send"); throw new Error("unexpected"); };
  const agent = new XAgent({
    _name: "claim-gate-agent",
    _channels: [channel],
    _message_lifecycle: {
      beforeSend() { events.push("persist-pending"); },
      beforeChannelSend() { events.push("claim-attempt"); throw new Error("private-db-error"); },
    },
  });
  await withRuntimeAgent(agent, async () => {
    const result = await explicitSend(agent);
    assert.equal(result._ok, false);
    assert.deepEqual(events, ["persist-pending", "claim-attempt"]);
    assert.equal(JSON.stringify(result).includes("private-db-error"), false);
  });
});

test("typed definitive rejection and unknown send outcomes stay distinguishable", async () => {
  for (const category of ["rejected", "rate_limited", "unknown"]) {
    let observed;
    const channel = new FakeChannel({ id: "lifecycle-channel" });
    channel.send = async () => { throw new XChannelSendFailure(category, "safe",
      category === "rate_limited" ? { _retry_after_ms: 7_000 } :
        category === "rejected" ? { _permanent: true } : {}); };
    const agent = new XAgent({
      _name: `send-category-${category.replaceAll("_", "-")}`,
      _channels: [channel],
      _message_lifecycle: {
        afterSend(_context, _message, outcome) { observed = outcome; },
      },
    });
    await withRuntimeAgent(agent, async () => {
      const result = await explicitSend(agent);
      assert.equal(result._ok, false);
      assert.equal(observed._status, "send_failed");
      assert.equal(observed._error._category, category);
      if (category === "rate_limited") assert.equal(observed._error._retry_after_ms, 7_000);
      if (category === "rejected") assert.equal(observed._error._permanent, true);
    });
  }
});

test("recovered send requires Channel policy and a completed application claim", async () => {
  const channel = new FakeChannel({ id: "lifecycle-channel" });
  const events = [];
  const agent = new XAgent({ _name: "recovery-policy-agent", _channels: [channel],
    _message_lifecycle: { beforeSend() { events.push("lifecycle"); } } });
  await withRuntimeAgent(agent, async () => {
    const message = { _channel_id: channel._id,
      _external_conversation_id: "external-conversation", _text: "hello" };
    await assert.rejects(() => agent.sendRecoveredMessage(message,
      async () => { events.push("claim"); }, 100),
    (error) => error._code === XAGENT_CHANNEL_ERROR_CODES.RECOVERY_NOT_AUTHORIZED);
    assert.deepEqual(events, []);
    channel.authorizeRecovery = () => { events.push("authorize"); return true; };
    const originalSend = channel.send.bind(channel);
    channel.send = async (payload) => {
      events.push("send"); return await originalSend(payload);
    };
    const result = await agent.sendRecoveredMessage(message,
      async () => { events.push("claim"); }, 100);
    assert.equal(result._accepted, true);
    assert.deepEqual(events, ["authorize", "claim", "send"]);
    assert.equal(channel.outbound.length, 1);
  });
});

test("pre-inbound and successful post-inbound lifecycle failures block later work", async () => {
  let handlerCalls = 0;
  const beforeChannel = new FakeChannel({ id: "lifecycle-channel" });
  class CountingAgent extends XAgent {
    async onMessage(message) {
      handlerCalls += 1;
      return {
        _external_conversation_id: message._external_conversation_id,
        _text: "response",
      };
    }
  }

  const beforeAgent = new CountingAgent({
    _name: "before-inbound-failure-agent",
    _channels: [beforeChannel],
    _message_lifecycle: {
      beforeInbound() {
        throw new Error("private-before-inbound-failure");
      },
    },
  });

  await withRuntimeAgent(beforeAgent, async () => {
    const response = await beforeChannel.inject(inbound());
    assert.equal(response._ok, false);
    assert.equal(
      response._result._code,
      XAGENT_CHANNEL_ERROR_CODES.MESSAGE_LIFECYCLE_FAILED,
    );
    assert.equal(handlerCalls, 0);
    assert.deepEqual(beforeChannel.outbound, []);
    assert.equal(
      JSON.stringify(response).includes("private-before-inbound-failure"),
      false,
    );
  });

  const afterChannel = new FakeChannel({ id: "lifecycle-channel" });
  const afterAgent = new CountingAgent({
    _name: "after-inbound-failure-agent",
    _channels: [afterChannel],
    _message_lifecycle: {
      afterInbound(_context, _message, outcome) {
        assert.equal(outcome._status, "processed");
        throw new Error("private-after-inbound-failure");
      },
    },
  });

  await withRuntimeAgent(afterAgent, async () => {
    const response = await afterChannel.inject(inbound());
    assert.equal(response._ok, false);
    assert.equal(
      response._result._code,
      XAGENT_CHANNEL_ERROR_CODES.MESSAGE_LIFECYCLE_FAILED,
    );
    assert.equal(handlerCalls, 1);
    assert.deepEqual(afterChannel.outbound, []);
  });
});

test("before-send failure blocks provider delivery after channel readiness checks", async () => {
  let beforeSendCalls = 0;
  const channel = new FakeChannel({ id: "lifecycle-channel" });
  const notReady = new FakeChannel({ id: "not-ready-channel", failStart: true });
  const agent = new XAgent({
    _name: "before-send-failure-agent",
    _channels: [channel, notReady],
    _message_lifecycle: {
      beforeSend() {
        beforeSendCalls += 1;
        throw new Error("private-before-send-failure");
      },
    },
  });

  await withRuntimeAgent(agent, async () => {
    const response = await explicitSend(agent);
    const unknown = await _x.execute({
      _module: agent._name,
      _op: "send-message",
      _params: {
        _channel_id: "missing-channel",
        _external_conversation_id: "external-conversation",
        _text: "unknown",
      },
    });
    const unavailable = await _x.execute({
      _module: agent._name,
      _op: "send-message",
      _params: {
        _channel_id: "not-ready-channel",
        _external_conversation_id: "external-conversation",
        _text: "unavailable",
      },
    });

    assert.equal(response._ok, false);
    assert.equal(
      response._result._code,
      XAGENT_CHANNEL_ERROR_CODES.MESSAGE_LIFECYCLE_FAILED,
    );
    assert.equal(unknown._result._code, XAGENT_CHANNEL_ERROR_CODES.NOT_FOUND);
    assert.equal(
      unavailable._result._code,
      XAGENT_CHANNEL_ERROR_CODES.NOT_READY,
    );
    assert.equal(beforeSendCalls, 1);
    assert.deepEqual(channel.outbound, []);
  });
});

test("post-acceptance lifecycle failure reports accepted provider state safely", async () => {
  const channel = new FakeChannel({ id: "lifecycle-channel" });
  const agent = new XAgent({
    _name: "post-acceptance-failure-agent",
    _channels: [channel],
    _message_lifecycle: {
      afterSend(_context, _message, outcome) {
        assert.equal(outcome._status, "accepted");
        throw new Error("private-post-acceptance-failure");
      },
    },
  });

  await withRuntimeAgent(agent, async () => {
    const response = await explicitSend(agent);

    assert.equal(channel.outbound.length, 1);
    assert.equal(response._ok, false);
    assert.equal(
      response._result._code,
      XAGENT_CHANNEL_ERROR_CODES.MESSAGE_LIFECYCLE_FAILED,
    );
    assert.deepEqual(response._result._meta, {
      _phase: "after-send",
      _channel_id: "lifecycle-channel",
      _provider_accepted: true,
      _external_message_id: "lifecycle-channel-out-1",
      _accepted_at: 1_700_000_000_001,
    });
    assert.equal(
      JSON.stringify(response).includes("private-post-acceptance-failure"),
      false,
    );
  });
});
