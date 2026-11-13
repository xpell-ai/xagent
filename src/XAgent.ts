import {
  XModule,
  XResponseError,
  XResponseOK,
  _x,
  _xu,
  type XCommand,
  type XModuleData,
  type XResponseData,
  type XpellSkill,
  type XpellSkillCommand,
} from "@xpell/node";

import {
  XAGENT_CHANNEL_ERROR_CODES,
  XAgentChannelError,
  type XAgentChannelErrorCode,
} from "./XAgentChannelError.js";
import type {
  XAgentMessageContext,
  XAgentMessageLifecycle,
} from "./XAgentMessageLifecycle.js";
import { XChannelSendFailure } from "./XChannelSendFailure.js";
import type {
  XAgentInboundMessage,
  XAgentOutboundMessage,
  XChannel,
  XChannelInboundMessage,
  XChannelLifecycleStatus,
  XChannelOutboundMessage,
  XChannelRuntime,
  XChannelSendResult,
  XChannelStatusData,
} from "./XChannel.js";

export type XAgentData = XModuleData & {
  _description?: string;
  _version?: string;
  _channels?: readonly XChannel[];
  _message_lifecycle?: XAgentMessageLifecycle;
};

export type XAgentRuntimeStatus = "created" | "starting" | "ready";

export type XAgentStatusData = {
  _name: string;
  _description?: string;
  _version?: string;
  _status: XAgentRuntimeStatus;
  _ready: boolean;
};

type XAgentOperationMetadata = XpellSkillCommand & {
  _id: string;
  _input_schema: Record<string, unknown>;
  _output_schema: Record<string, unknown>;
  _errors: string[];
  _permissions: string[];
  _examples: Array<Record<string, unknown>>;
  _side_effects: "none" | "channel-send";
};

type XAgentSkillMetadata = XpellSkill & {
  _name: string;
  _scope: "server";
  _package: "@xpell/agent";
  _runtime: {
    _target: "server";
    _hosts: ["xnode"];
    _xpell_core: string;
    _xpell_node: string;
  };
  _ops: typeof XAGENT_OPS;
  _config: [];
  _secrets: [];
  _permissions: [];
  _readiness: {
    _status: "unknown";
    _checks: ["xmodule.load"];
  };
  _examples: Array<Record<string, unknown>>;
};

type OwnedChannel = {
  channel: XChannel;
  status: XChannelLifecycleStatus;
  error?: XChannelStatusData["_error"];
};

const XAGENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const channelOwners = new WeakMap<XChannel, XAgent>();

const inboundMessageSchema = {
  type: "object",
  required: [
    "_channel_id",
    "_external_user_id",
    "_external_conversation_id",
    "_external_message_id",
    "_text",
  ],
  properties: {
    _channel_id: { type: "string" },
    _external_user_id: { type: "string" },
    _external_conversation_id: { type: "string" },
    _external_message_id: { type: "string" },
    _text: { type: "string" },
    _timestamp: { type: "number" },
    _reply_to_external_message_id: { type: "string" },
  },
  additionalProperties: false,
};

const outboundMessageSchema = {
  type: "object",
  required: ["_channel_id", "_external_conversation_id", "_text"],
  properties: {
    _channel_id: { type: "string" },
    _external_conversation_id: { type: "string" },
    _text: { type: "string" },
    _reply_to_external_message_id: { type: "string" },
  },
  additionalProperties: false,
};

const sendResultSchema = {
  type: "object",
  required: ["_accepted", "_external_message_id", "_accepted_at"],
  properties: {
    _accepted: { const: true },
    _external_message_id: { type: "string" },
    _accepted_at: { type: "number" },
  },
  additionalProperties: false,
};

export const XAGENT_OPS = {
  status: {
    _id: "status",
    _name: "status",
    _scope: "server",
    _description: "Return the agent's runtime identity, metadata, and readiness state.",
    _params: {},
    _input_schema: {
      type: "object",
      additionalProperties: false,
    },
    _output_schema: {
      type: "object",
      required: ["_name", "_status", "_ready"],
      properties: {
        _name: { type: "string" },
        _description: { type: "string" },
        _version: { type: "string" },
        _status: { enum: ["created", "starting", "ready"] },
        _ready: { type: "boolean" },
      },
      additionalProperties: false,
    },
    _errors: [],
    _permissions: [],
    _examples: [
      {
        _module: "centrum",
        _op: "status",
        _params: {},
      },
    ],
    _side_effects: "none",
  },
  "list-channels": {
    _id: "list-channels",
    _name: "list-channels",
    _scope: "server",
    _description: "List the channels owned by this agent and their safe lifecycle state.",
    _params: {},
    _input_schema: {
      type: "object",
      additionalProperties: false,
    },
    _output_schema: {
      type: "object",
      required: ["_channels"],
      properties: {
        _channels: { type: "array" },
      },
      additionalProperties: false,
    },
    _errors: [],
    _permissions: [],
    _examples: [
      {
        _module: "centrum",
        _op: "list-channels",
        _params: {},
      },
    ],
    _side_effects: "none",
  },
  "receive-message": {
    _id: "receive-message",
    _name: "receive-message",
    _scope: "server",
    _description: "Receive one normalized message from an agent-owned channel.",
    _params: {},
    _input_schema: inboundMessageSchema,
    _output_schema: {
      anyOf: [{ type: "null" }, sendResultSchema],
    },
    _errors: [
      XAGENT_CHANNEL_ERROR_CODES.NOT_FOUND,
      XAGENT_CHANNEL_ERROR_CODES.NOT_READY,
      XAGENT_CHANNEL_ERROR_CODES.BAD_MESSAGE,
      XAGENT_CHANNEL_ERROR_CODES.SEND_FAILED,
      XAGENT_CHANNEL_ERROR_CODES.MESSAGE_HANDLER_FAILED,
      XAGENT_CHANNEL_ERROR_CODES.MESSAGE_LIFECYCLE_FAILED,
    ],
    _permissions: [],
    _examples: [],
    _side_effects: "channel-send",
  },
  "send-message": {
    _id: "send-message",
    _name: "send-message",
    _scope: "server",
    _description: "Send one normalized message through an explicitly selected owned channel.",
    _params: {},
    _input_schema: outboundMessageSchema,
    _output_schema: sendResultSchema,
    _errors: [
      XAGENT_CHANNEL_ERROR_CODES.NOT_FOUND,
      XAGENT_CHANNEL_ERROR_CODES.NOT_READY,
      XAGENT_CHANNEL_ERROR_CODES.BAD_MESSAGE,
      XAGENT_CHANNEL_ERROR_CODES.SEND_FAILED,
      XAGENT_CHANNEL_ERROR_CODES.MESSAGE_LIFECYCLE_FAILED,
    ],
    _permissions: [],
    _examples: [
      {
        _module: "centrum",
        _op: "send-message",
        _params: {
          _channel_id: "web-chat",
          _external_conversation_id: "conversation-1",
          _text: "Hello",
        },
      },
    ],
    _side_effects: "channel-send",
  },
} satisfies Record<string, XAgentOperationMetadata>;

export const XAGENT_SKILL: XAgentSkillMetadata = {
  _id: "xagent",
  _name: "agent",
  _title: "XAgent Runtime Primitive",
  _version: "2.0.8",
  _active: true,
  _type: "server-module-api",
  _scope: "server",
  _package: "@xpell/agent",
  _requires: ["xmodule"],
  _description:
    "XNode-hosted agent runtime primitive with agent-owned provider channels and normalized message routing.",
  _runtime: {
    _target: "server",
    _hosts: ["xnode"],
    _xpell_core: ">=2.0.0",
    _xpell_node: ">=2.0.0",
  },
  _ops: XAGENT_OPS,
  _config: [],
  _secrets: [],
  _permissions: [],
  _readiness: {
    _status: "unknown",
    _checks: ["xmodule.load"],
  },
  _examples: [
    {
      _module: "centrum",
      _op: "status",
      _params: {},
    },
    {
      _module: "centrum",
      _op: "list-channels",
      _params: {},
    },
  ],
  _exports: {
    _modules: [
      {
        _name: "agent",
        _scope: "server",
        _description:
          "An XAgent instance uses its configured agent name as its runtime module name.",
        _ops: Object.values(XAGENT_OPS),
      },
    ],
  },
  _core_rules: [
    "An agent runs inside XNode as an explicitly registered XModule.",
    "The agent _name is its stable runtime identity and Xpell module name.",
    "Channels are plain provider adapters owned by one agent, not XModules.",
    "Provider ingress routes through a bound runtime and _x.execute.",
    "Agent outbound delivery calls the selected owned channel directly.",
    "Agent readiness is independent from channel readiness.",
  ],
};

function readAgentData(data: XAgentData): XAgentData {
  const input = _xu.ensure_object(data, "agent");
  const name = _xu.ensure_string(input._name, "_name");

  if (input._name !== name || !XAGENT_ID_PATTERN.test(name)) {
    throw new Error("Invalid '_name': expected lowercase kebab-case agent identity");
  }

  if (input._channels !== undefined && !Array.isArray(input._channels)) {
    throw new XAgentChannelError(
      XAGENT_CHANNEL_ERROR_CODES.INVALID,
      "Invalid '_channels': expected an array of Channel adapters",
    );
  }

  const messageLifecycle = readMessageLifecycle(input._message_lifecycle);

  return {
    _name: name,
    _description: _xu.read_optional_string(input._description, "_description"),
    _version: _xu.read_optional_string(input._version, "_version"),
    ...(input._channels !== undefined
      ? { _channels: input._channels as unknown as readonly XChannel[] }
      : {}),
    ...(messageLifecycle !== undefined
      ? { _message_lifecycle: messageLifecycle }
      : {}),
  };
}

function readMessageLifecycle(value: unknown): XAgentMessageLifecycle | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new XAgentChannelError(
      XAGENT_CHANNEL_ERROR_CODES.MESSAGE_LIFECYCLE_FAILED,
      "Invalid Agent message lifecycle",
      { _phase: "configuration" },
    );
  }

  const lifecycle = value as Record<string, unknown>;
  for (const callback of [
    "beforeInbound",
    "afterInbound",
    "beforeSend",
    "beforeChannelSend",
    "afterSend",
  ]) {
    if (
      lifecycle[callback] !== undefined &&
      typeof lifecycle[callback] !== "function"
    ) {
      throw new XAgentChannelError(
        XAGENT_CHANNEL_ERROR_CODES.MESSAGE_LIFECYCLE_FAILED,
        "Invalid Agent message lifecycle",
        { _phase: "configuration" },
      );
    }
  }

  return value as XAgentMessageLifecycle;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new XAgentChannelError(
      XAGENT_CHANNEL_ERROR_CODES.BAD_MESSAGE,
      `${label} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  field: string,
  errorCode: XAgentChannelErrorCode = XAGENT_CHANNEL_ERROR_CODES.BAD_MESSAGE,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new XAgentChannelError(errorCode, `${field} must be a non-empty string`);
  }
  return value;
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function readOptionalTimestamp(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new XAgentChannelError(
      XAGENT_CHANNEL_ERROR_CODES.BAD_MESSAGE,
      "_timestamp must be a non-negative finite number",
    );
  }
  return value;
}

function readInboundMessage(value: unknown): XAgentInboundMessage {
  const input = requireObject(value, "Inbound message");
  const timestamp = readOptionalTimestamp(input._timestamp);
  const replyTo = readOptionalString(
    input._reply_to_external_message_id,
    "_reply_to_external_message_id",
  );

  return {
    _channel_id: requireString(input._channel_id, "_channel_id"),
    _external_user_id: requireString(input._external_user_id, "_external_user_id"),
    _external_conversation_id: requireString(
      input._external_conversation_id,
      "_external_conversation_id",
    ),
    _external_message_id: requireString(
      input._external_message_id,
      "_external_message_id",
    ),
    _text: requireString(input._text, "_text"),
    ...(timestamp !== undefined ? { _timestamp: timestamp } : {}),
    ...(replyTo !== undefined
      ? { _reply_to_external_message_id: replyTo }
      : {}),
  };
}

function readOutboundMessage(
  value: unknown,
  includeChannelId: true,
): XAgentOutboundMessage;
function readOutboundMessage(
  value: unknown,
  includeChannelId: false,
): XChannelOutboundMessage;
function readOutboundMessage(
  value: unknown,
  includeChannelId: boolean,
): XAgentOutboundMessage | XChannelOutboundMessage {
  const input = requireObject(value, "Outbound message");
  const replyTo = readOptionalString(
    input._reply_to_external_message_id,
    "_reply_to_external_message_id",
  );
  const message: XChannelOutboundMessage = {
    _external_conversation_id: requireString(
      input._external_conversation_id,
      "_external_conversation_id",
    ),
    _text: requireString(input._text, "_text"),
    ...(replyTo !== undefined
      ? { _reply_to_external_message_id: replyTo }
      : {}),
  };

  if (!includeChannelId) return message;
  return {
    _channel_id: requireString(input._channel_id, "_channel_id"),
    ...message,
  };
}

function validateChannel(channel: XChannel): void {
  if (channel === null || typeof channel !== "object") {
    throw new XAgentChannelError(
      XAGENT_CHANNEL_ERROR_CODES.INVALID,
      "Channel must be an object",
    );
  }

  const id = requireString(
    channel._id,
    "Channel _id",
    XAGENT_CHANNEL_ERROR_CODES.INVALID,
  );
  const provider = requireString(
    channel._provider,
    "Channel _provider",
    XAGENT_CHANNEL_ERROR_CODES.INVALID,
  );

  if (!XAGENT_ID_PATTERN.test(id) || !XAGENT_ID_PATTERN.test(provider)) {
    throw new XAgentChannelError(
      XAGENT_CHANNEL_ERROR_CODES.INVALID,
      "Channel _id and _provider must use lowercase kebab-case",
      { _channel_id: id },
    );
  }

  for (const method of ["start", "stop", "getStatus", "send"] as const) {
    if (typeof channel[method] !== "function") {
      throw new XAgentChannelError(
        XAGENT_CHANNEL_ERROR_CODES.INVALID,
        `Channel '${id}' must implement ${method}()`,
        { _channel_id: id },
      );
    }
  }
  if (channel.authorizeRecovery !== undefined &&
      typeof channel.authorizeRecovery !== "function") {
    throw new XAgentChannelError(
      XAGENT_CHANNEL_ERROR_CODES.INVALID,
      `Channel '${id}' has an invalid recovery policy`,
      { _channel_id: id },
    );
  }
}

async function withRecoveryDeadline<T>(promise: Promise<T> | T,
  timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Recovery deadline exceeded")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeStatusError(
  code: string,
  message: string,
): NonNullable<XChannelStatusData["_error"]> {
  return { _code: code, _message: message };
}

function createMessageContext(
  agentName: string,
  origin: XAgentMessageContext["_origin"],
): XAgentMessageContext {
  return Object.freeze({
    _agent_name: agentName,
    _origin: origin,
  });
}

function readonlyInboundMessage(
  message: XAgentInboundMessage,
): Readonly<XAgentInboundMessage> {
  return Object.freeze({ ...message });
}

function readonlyOutboundMessage(
  message: XAgentOutboundMessage,
): Readonly<XAgentOutboundMessage> {
  return Object.freeze({ ...message });
}

function safeErrorView(error: XAgentChannelError) {
  return Object.freeze({
    _code: error._code,
    _message: error.message,
  });
}

function handlerError(channelId: string): XAgentChannelError {
  return new XAgentChannelError(
    XAGENT_CHANNEL_ERROR_CODES.MESSAGE_HANDLER_FAILED,
    "Agent message handler failed",
    { _channel_id: channelId },
  );
}

function lifecycleError(
  phase: "before-inbound" | "after-inbound" | "before-send" | "before-channel-send" | "after-send",
  meta: Record<string, unknown> = {},
): XAgentChannelError {
  return new XAgentChannelError(
    XAGENT_CHANNEL_ERROR_CODES.MESSAGE_LIFECYCLE_FAILED,
    `Agent message lifecycle failed during ${phase}`,
    { _phase: phase, ...meta },
  );
}

/**
 * Agent runtime primitive hosted by XNode.
 *
 * XAgent reuses XModule identity, loading, command dispatch, and runtime
 * discovery. Channels are plain owned adapters and never enter the module
 * registry.
 */
export class XAgent extends XModule {
  static _ops = XAGENT_OPS;
  static _skill = XAGENT_SKILL;

  readonly _description?: string;
  readonly _version?: string;

  readonly #channels = new Map<string, OwnedChannel>();
  readonly #messageLifecycle?: XAgentMessageLifecycle;

  constructor(data: XAgentData) {
    const agent = readAgentData(data);
    super({ _name: agent._name });
    this._description = agent._description;
    this._version = agent._version;
    this.#messageLifecycle = agent._message_lifecycle;

    const channels = agent._channels ?? [];
    const ids = new Set<string>();

    for (const channel of channels) {
      validateChannel(channel);
      if (ids.has(channel._id)) {
        throw new XAgentChannelError(
          XAGENT_CHANNEL_ERROR_CODES.DUPLICATE,
          `Duplicate Channel ID '${channel._id}'`,
          { _channel_id: channel._id },
        );
      }
      const owner = channelOwners.get(channel);
      if (owner !== undefined && owner !== this) {
        throw new XAgentChannelError(
          XAGENT_CHANNEL_ERROR_CODES.INVALID,
          `Channel '${channel._id}' already belongs to another Agent`,
          { _channel_id: channel._id },
        );
      }
      ids.add(channel._id);
    }

    for (const channel of channels) {
      this.addChannel(channel);
    }
  }

  override getCommandSkills(): XpellSkillCommand[] {
    const commands = super.getCommandSkills();
    const names = new Set(commands.map((command) => command._name));

    return [
      ...commands,
      ...Object.values(XAGENT_OPS).filter((operation) => !names.has(operation._name)),
    ];
  }

  protected override async onLoad(): Promise<void> {
    for (const owned of this.#channels.values()) {
      await this.startChannel(owned);
    }
  }

  /** Register an adapter before XModule loading begins. */
  registerChannel(channel: XChannel): void {
    if (this._loading || this._loaded) {
      throw new XAgentChannelError(
        XAGENT_CHANNEL_ERROR_CODES.INVALID,
        "Channels can only be registered before Agent loading begins",
        { _agent_name: this._name },
      );
    }
    validateChannel(channel);
    if (this.#channels.has(channel._id)) {
      throw new XAgentChannelError(
        XAGENT_CHANNEL_ERROR_CODES.DUPLICATE,
        `Duplicate Channel ID '${channel._id}'`,
        { _channel_id: channel._id },
      );
    }
    const owner = channelOwners.get(channel);
    if (owner !== undefined && owner !== this) {
      throw new XAgentChannelError(
        XAGENT_CHANNEL_ERROR_CODES.INVALID,
        `Channel '${channel._id}' already belongs to another Agent`,
        { _channel_id: channel._id },
      );
    }
    this.addChannel(channel);
  }

  /** Return safe Agent-scoped channel discovery data. */
  listChannels(): XChannelStatusData[] {
    return Array.from(this.#channels.values(), (owned) => ({
      _id: owned.channel._id,
      _provider: owned.channel._provider,
      _status: owned.status,
      _ready: owned.status === "ready",
      ...(owned.error !== undefined ? { _error: { ...owned.error } } : {}),
    }));
  }

  /** Trusted application-only delivery of one persisted reply; no generation or lifecycle replay. */
  async sendRecoveredMessage(
    message: XAgentOutboundMessage,
    beforeChannelSend: () => Promise<void>,
    timeoutMs: number,
  ): Promise<XChannelSendResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
        typeof beforeChannelSend !== "function") {
      throw new XAgentChannelError(XAGENT_CHANNEL_ERROR_CODES.INVALID,
        "Invalid recovery send configuration");
    }
    const outbound = readOutboundMessage(message, true);
    const owned = this.requireChannel(outbound._channel_id);
    if (owned.status !== "ready" || !owned.channel.getStatus()._ready) {
      throw new XAgentChannelError(XAGENT_CHANNEL_ERROR_CODES.NOT_READY,
        "Recovery Channel is not ready");
    }
    if (!owned.channel.authorizeRecovery) {
      throw new XAgentChannelError(XAGENT_CHANNEL_ERROR_CODES.RECOVERY_NOT_AUTHORIZED,
        "Recovery is not authorized for this Channel");
    }
    const channelMessage: XChannelOutboundMessage = Object.freeze({
      _external_conversation_id: outbound._external_conversation_id,
      _text: outbound._text,
      ...(outbound._reply_to_external_message_id
        ? { _reply_to_external_message_id: outbound._reply_to_external_message_id } : {}),
    });
    let allowed = false;
    try {
      allowed = await withRecoveryDeadline(
        owned.channel.authorizeRecovery(channelMessage), timeoutMs);
    } catch {
      // A failed or timed-out policy check occurs before any durable claim.
    }
    if (allowed !== true) {
      throw new XAgentChannelError(XAGENT_CHANNEL_ERROR_CODES.RECOVERY_NOT_AUTHORIZED,
        "Recovery is not authorized for this Channel");
    }
    await beforeChannelSend();
    const result = await withRecoveryDeadline(owned.channel.send(channelMessage), timeoutMs);
    if (result?._accepted !== true ||
        typeof result._external_message_id !== "string" ||
        !result._external_message_id ||
        typeof result._accepted_at !== "number" ||
        !Number.isFinite(result._accepted_at) || result._accepted_at < 0) {
      throw new Error("Invalid recovery Channel send result");
    }
    return { _accepted: true, _external_message_id: result._external_message_id,
      _accepted_at: result._accepted_at };
  }

  /** Explicitly stop owned channels without inventing an XModule unload hook. */
  async stopChannels(): Promise<void> {
    for (const owned of this.#channels.values()) {
      if (owned.status === "stopped" || owned.status === "registered") {
        if (owned.status === "registered") owned.status = "stopped";
        continue;
      }
      try {
        await owned.channel.stop();
        owned.status = "stopped";
        owned.error = undefined;
      } catch {
        owned.status = "not_ready";
        owned.error = safeStatusError(
          XAGENT_CHANNEL_ERROR_CODES.NOT_READY,
          "Channel failed to stop cleanly",
        );
      }
    }
  }

  getStatus(): XAgentStatusData {
    const status: XAgentRuntimeStatus = this._loading
      ? "starting"
      : this._loaded
        ? "ready"
        : "created";

    return {
      _name: this._name,
      ...(this._description !== undefined
        ? { _description: this._description }
        : {}),
      ...(this._version !== undefined ? { _version: this._version } : {}),
      _status: status,
      _ready: status === "ready",
    };
  }

  async _status(_xcmd: XCommand): Promise<XResponseData> {
    return new XResponseOK(this.getStatus()).toXData();
  }

  async _list_channels(_xcmd: XCommand): Promise<XResponseData> {
    return new XResponseOK({ _channels: this.listChannels() }).toXData();
  }

  async _receive_message(xcmd: XCommand): Promise<XResponseData> {
    let message: XAgentInboundMessage;

    try {
      message = readInboundMessage(xcmd?._params);
      this.requireChannel(message._channel_id);
    } catch (error) {
      return new XResponseError(error).toXData();
    }

    const context = createMessageContext(this._name, "inbound");
    const lifecycleMessage = readonlyInboundMessage(message);

    let control: void | { readonly _action: "handled" };
    try {
      control = await this.#messageLifecycle?.beforeInbound?.(
        context,
        lifecycleMessage,
      );
    } catch {
      return new XResponseError(
        lifecycleError("before-inbound", {
          _channel_id: message._channel_id,
        }),
      ).toXData();
    }
    if (
      control !== undefined &&
      (control === null ||
        typeof control !== "object" ||
        control._action !== "handled")
    ) {
      return new XResponseError(
        lifecycleError("before-inbound", {
          _channel_id: message._channel_id,
        }),
      ).toXData();
    }
    if (control?._action === "handled") {
      return new XResponseOK(null).toXData();
    }

    let response: XChannelOutboundMessage | undefined;
    try {
      const handlerResponse = await this.onMessage(message, context);
      response =
        handlerResponse === undefined
          ? undefined
          : readOutboundMessage(handlerResponse, false);
    } catch {
      const safeError = handlerError(message._channel_id);
      try {
        await this.#messageLifecycle?.afterInbound?.(
          context,
          lifecycleMessage,
          Object.freeze({
            _status: "processing_failed" as const,
            _error: safeErrorView(safeError),
          }),
        );
      } catch {
        // The primary safe handler failure remains authoritative.
      }
      return new XResponseError(safeError).toXData();
    }

    try {
      await this.#messageLifecycle?.afterInbound?.(
        context,
        lifecycleMessage,
        Object.freeze({ _status: "processed" as const }),
      );
    } catch {
      return new XResponseError(
        lifecycleError("after-inbound", {
          _channel_id: message._channel_id,
        }),
      ).toXData();
    }

    if (response === undefined) {
      return new XResponseOK(null).toXData();
    }

    try {
      const result = await this.sendMessage(context, {
        _channel_id: message._channel_id,
        ...response,
      });
      return new XResponseOK(result).toXData();
    } catch (error) {
      return new XResponseError(error).toXData();
    }
  }

  async _send_message(xcmd: XCommand): Promise<XResponseData> {
    try {
      const message = readOutboundMessage(xcmd?._params, true);
      const context = createMessageContext(this._name, "explicit");
      const result = await this.sendMessage(context, message);
      return new XResponseOK(result).toXData();
    } catch (error) {
      return new XResponseError(error).toXData();
    }
  }

  /** Override with Agent behavior. Returning undefined sends no reply. */
  protected async onMessage(
    _message: XAgentInboundMessage,
    _context: XAgentMessageContext,
  ): Promise<XChannelOutboundMessage | void> {
    return undefined;
  }

  private addChannel(channel: XChannel): void {
    channelOwners.set(channel, this);
    this.#channels.set(channel._id, {
      channel,
      status: "registered",
    });
  }

  private async startChannel(owned: OwnedChannel): Promise<void> {
    if (owned.status !== "registered") return;
    owned.status = "starting";
    owned.error = undefined;

    try {
      await owned.channel.start(this.createChannelRuntime(owned.channel._id));
      owned.status = "ready";
    } catch {
      owned.status = "not_ready";
      owned.error = safeStatusError(
        XAGENT_CHANNEL_ERROR_CODES.NOT_READY,
        "Channel failed to start",
      );
    }
  }

  private createChannelRuntime(channelId: string): XChannelRuntime {
    const agentName = this._name;
    return {
      async receive(message: XChannelInboundMessage): Promise<XResponseData> {
        const input =
          message !== null && typeof message === "object"
            ? (message as Partial<XChannelInboundMessage>)
            : {};
        const params: XAgentInboundMessage = {
          _channel_id: channelId,
          _external_user_id: input._external_user_id as string,
          _external_conversation_id:
            input._external_conversation_id as string,
          _external_message_id: input._external_message_id as string,
          _text: input._text as string,
          ...(input._timestamp !== undefined
            ? { _timestamp: input._timestamp }
            : {}),
          ...(input._reply_to_external_message_id !== undefined
            ? {
                _reply_to_external_message_id:
                  input._reply_to_external_message_id,
              }
            : {}),
        };

        return await _x.execute({
          _module: agentName,
          _op: "receive-message",
          _params: params,
        });
      },
    };
  }

  private requireChannel(channelId: string): OwnedChannel {
    const owned = this.#channels.get(channelId);
    if (owned === undefined) {
      throw new XAgentChannelError(
        XAGENT_CHANNEL_ERROR_CODES.NOT_FOUND,
        `Channel '${channelId}' is not registered on Agent '${this._name}'`,
        { _channel_id: channelId },
      );
    }
    return owned;
  }

  private async sendMessage(
    context: XAgentMessageContext,
    message: XAgentOutboundMessage,
  ): Promise<XChannelSendResult> {
    const owned = this.requireChannel(message._channel_id);
    if (owned.status !== "ready") {
      throw new XAgentChannelError(
        XAGENT_CHANNEL_ERROR_CODES.NOT_READY,
        `Channel '${owned.channel._id}' is not ready`,
        { _channel_id: owned.channel._id },
      );
    }

    const lifecycleMessage = readonlyOutboundMessage(message);
    try {
      await this.#messageLifecycle?.beforeSend?.(context, lifecycleMessage);
    } catch {
      throw lifecycleError("before-send", {
        _channel_id: message._channel_id,
      });
    }

    const channelMessage: XChannelOutboundMessage = {
      _external_conversation_id: message._external_conversation_id,
      _text: message._text,
      ...(message._reply_to_external_message_id !== undefined
        ? {
            _reply_to_external_message_id:
              message._reply_to_external_message_id,
          }
        : {}),
    };

    try {
      await this.#messageLifecycle?.beforeChannelSend?.(context, lifecycleMessage);
    } catch {
      throw lifecycleError("before-channel-send", {
        _channel_id: message._channel_id,
      });
    }

    let result: XChannelSendResult;
    try {
      const candidate = await owned.channel.send(channelMessage);
      if (
        candidate?._accepted !== true ||
        typeof candidate._external_message_id !== "string" ||
        candidate._external_message_id.length === 0 ||
        typeof candidate._accepted_at !== "number" ||
        !Number.isFinite(candidate._accepted_at) ||
        candidate._accepted_at < 0
      ) {
        throw new Error("Invalid Channel send result");
      }
      result = {
        _accepted: true,
        _external_message_id: candidate._external_message_id,
        _accepted_at: candidate._accepted_at,
      };
    } catch (error) {
      const category = error instanceof XChannelSendFailure &&
        (error._send_failure_category === "rejected" ||
          error._send_failure_category === "rate_limited")
        ? error._send_failure_category
        : "unknown";
      const safeError = new XAgentChannelError(
        XAGENT_CHANNEL_ERROR_CODES.SEND_FAILED,
        `Channel '${owned.channel._id}' failed to accept the message`,
        {
          _channel_id: owned.channel._id,
          _provider: owned.channel._provider,
        },
      );
      try {
        await this.#messageLifecycle?.afterSend?.(
          context,
          lifecycleMessage,
          Object.freeze({
            _status: "send_failed" as const,
            _error: Object.freeze({ ...safeErrorView(safeError), _category: category,
              ...(error instanceof XChannelSendFailure
                ? { _permanent: error._permanent,
                    ...(error._retry_after_ms !== undefined
                      ? { _retry_after_ms: error._retry_after_ms } : {}) }
                : {}) }),
          }),
        );
      } catch {
        // The primary safe provider failure remains authoritative.
      }
      throw safeError;
    }

    try {
      await this.#messageLifecycle?.afterSend?.(
        context,
        lifecycleMessage,
        Object.freeze({
          _status: "accepted" as const,
          _result: Object.freeze({ ...result }),
        }),
      );
    } catch {
      throw lifecycleError("after-send", {
        _channel_id: message._channel_id,
        _provider_accepted: true,
        _external_message_id: result._external_message_id,
        _accepted_at: result._accepted_at,
      });
    }

    return result;
  }
}
