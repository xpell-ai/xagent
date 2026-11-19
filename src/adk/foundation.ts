import { mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { _x, XNode, type XResponseData } from "@xpell/node";

import { XAgent, type XAgentStatusData } from "../XAgent.js";
import type { XAgentMessageContext, XAgentMessageLifecycle } from "../XAgentMessageLifecycle.js";
import type {
  XAgentInboundMessage, XChannelInboundMessage, XChannel, XChannelOutboundMessage,
  XChannelRuntime, XChannelSendResult, XChannelStatusData,
} from "../XChannel.js";

export type MockTextModel = Readonly<{ _type: "mock-text"; _text: string }>;
export type MockChannel = Readonly<{ _type: "mock"; _id: string }>;
export type AgentFoundationOptions = {
  _name: string;
  _model: MockTextModel;
  _channel: MockChannel;
  _host: {
    /** Absolute, not-yet-existing directory in an operator-owned parent. */
    _work_folder: string;
    /** XNode opens HTTP; Phase 1 requires explicit loopback consent. */
    _listen: { _host: "127.0.0.1" | "::1"; _port: number };
  };
  /** Only zero plugins are supported in Foundation Phase 1. */
  _plugins?: readonly never[];
};
export type AgentFoundationStatus = Readonly<{
  _state: "created" | "starting" | "ready" | "closing" | "closed";
  _agent: XAgentStatusData;
  _channels: readonly XChannelStatusData[];
}>;
export type AgentFoundation = Readonly<{
  start(): Promise<void>;
  close(): Promise<void>;
  /** Synthetic local ingress, never an authenticated Principal. */
  testTurn(input: { _text: string }): Promise<string>;
  getStatus(): AgentFoundationStatus;
}>;

/** Internal composition port; not exported by the public ADK entry. */
export type FoundationAdapter = {
  /** Internal opt-in for profiles requiring XNode's existing WAL/FULL policy. */
  _entity_sqlite?: Readonly<{ _require_full_durability: true }>;
  _lifecycle: XAgentMessageLifecycle;
  prepareFolder(folder: string): Promise<void>;
  _system_xapps_path: string;
  afterStart(): Promise<void>;
  beforeModel(context: XAgentMessageContext, message: XAgentInboundMessage): Promise<string | void>;
  replay(message: XChannelInboundMessage): Promise<string>;
  turn(input: unknown, invoke: (message: XChannelInboundMessage) => Promise<string>): Promise<string>;
  close(ownsGraph: boolean): Promise<void>;
};

/** Private P2.2 resource seam. Never combined with a durable profile adapter. */
export type FoundationResources = {
  readonly _system_xapps_path?: string;
  preflight(): Promise<void>;
  materialize(): Promise<void>;
  afterStart(): Promise<void>;
  close(): Promise<void>;
};

/** Private experimental Host-only seam; never combined with a durable adapter. */
export type FoundationTurns = {
  readonly _lifecycle: XAgentMessageLifecycle;
  turn(input: unknown, invoke: (message: XChannelInboundMessage) => Promise<string>): Promise<string>;
  beforeModel(context: XAgentMessageContext, message: XAgentInboundMessage): Promise<string>;
  beforeReply(message: XChannelOutboundMessage): void;
  close(): Promise<void>;
};

export class AgentAdkError extends Error {
  constructor(readonly _code: string, message: string) {
    super(message);
    this.name = "AgentAdkError";
  }
}

export function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key))) {
    throw new AgentAdkError("E_ADK_CONFIG", "Unsupported Foundation configuration");
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AgentAdkError("E_ADK_CONFIG", "Expected nonempty Foundation text");
  }
  return value;
}

/** A deterministic local fixture, not an external XAI provider. */
export function mockTextModel(input: { _text: string }): MockTextModel {
  const value = record(input, ["_text"]);
  return Object.freeze({ _type: "mock-text", _text: text(value._text) });
}

/** Configure one Agent-owned in-memory fixture Channel. */
export function mockChannel(input: { _id: string }): MockChannel {
  const value = record(input, ["_id"]);
  return Object.freeze({ _type: "mock", _id: text(value._id) });
}

class FoundationChannel implements XChannel {
  readonly _provider = "mock";
  #runtime?: XChannelRuntime;
  #ready = false;
  #sequence = 0;
  #replies = new Map<string, string | undefined>();

  constructor(readonly _id: string, private readonly adapter?: FoundationAdapter, private readonly turns?: FoundationTurns) {}

  start(runtime: XChannelRuntime): void {
    this.#runtime = runtime;
    this.#ready = true;
  }

  stop(): void {
    this.#ready = false;
    this.#runtime = undefined;
  }

  getStatus(): XChannelStatusData {
    return { _id: this._id, _provider: this._provider,
      _status: this.#ready ? "ready" : "stopped", _ready: this.#ready };
  }

  async send(message: XChannelOutboundMessage): Promise<XChannelSendResult> {
    const id = message._reply_to_external_message_id;
    const key = JSON.stringify([message._external_conversation_id, id]);
    if (!this.#ready || !id || !this.#replies.has(key)) {
      throw new AgentAdkError("E_ADK_MOCK_REPLY", "No active mock turn for reply");
    }
    this.turns?.beforeReply(message);
    this.#replies.set(key, message._text);
    return { _accepted: true, _external_message_id: `mock-out-${id}`,
      _accepted_at: Date.now() };
  }

  async turn(value: string, fixture?: XChannelInboundMessage): Promise<string> {
    if (!this.#ready || !this.#runtime) {
      throw new AgentAdkError("E_ADK_NOT_READY", "Mock Channel is not ready");
    }
    const message = fixture ?? {
      _external_user_id: "mock-participant", _external_conversation_id: "mock-conversation",
      _external_message_id: `mock-in-${++this.#sequence}`, _text: value,
    };
    const id = message._external_message_id;
    const key = JSON.stringify([message._external_conversation_id, id]);
    this.#replies.set(key, undefined);
    try {
      // The bound runtime injects channel identity and enters _x.execute.
      const response: XResponseData = await this.#runtime.receive(message);
      const reply = this.#replies.get(key);
      if (response._ok === true && reply === undefined && this.adapter) return await this.adapter.replay(message);
      if (response._ok !== true || reply === undefined) {
        throw new AgentAdkError("E_ADK_MOCK_TURN", "Mock turn did not produce an accepted reply");
      }
      return reply;
    } finally {
      this.#replies.delete(key);
    }
  }
}

class FoundationAgent extends XAgent {
  constructor(name: string, channel: FoundationChannel, private readonly model: MockTextModel,
    private readonly adapter?: FoundationAdapter, private readonly turns?: FoundationTurns) {
    super({ _name: name, _channels: [channel],
      ...(adapter || turns ? { _message_lifecycle: (adapter ?? turns)!._lifecycle } : {}) });
  }

  protected override async onMessage(message: XAgentInboundMessage, context: XAgentMessageContext): Promise<XChannelOutboundMessage> {
    const generated = this.turns ? await this.turns.beforeModel(context, message) : await this.adapter?.beforeModel(context, message);
    // Default mode stays a local fixed mock; explicit composition may supply text.
    return { _external_conversation_id: message._external_conversation_id,
      _text: generated ?? this.model._text, _reply_to_external_message_id: message._external_message_id };
  }
}

// This lease only coordinates this opt-in facade. XNode remains Core owner
// and independently rejects foreign/duplicate hosts. Its globals are untouched.
let activeHost: symbol | undefined;

/** Construct without I/O. start() owns fresh XNode files and explicit HTTP. */
export function createAgent(options: AgentFoundationOptions): AgentFoundation {
  return composeFoundation(options);
}

export function composeFoundation(options: AgentFoundationOptions, adapter?: FoundationAdapter, resources?: FoundationResources, turnPort?: FoundationTurns): AgentFoundation {
  if (adapter && (resources || turnPort)) throw new AgentAdkError("E_ADK_CONFIG", "Resource/turn and durable profiles cannot be combined");
  const config = record(options, ["_name", "_model", "_channel", "_host", "_plugins"]);
  const model = record(config._model, ["_type", "_text"]);
  const channelConfig = record(config._channel, ["_type", "_id"]);
  const host = record(config._host, ["_work_folder", "_listen"]);
  const listen = record(host._listen, ["_host", "_port"]);
  if (model._type !== "mock-text" || channelConfig._type !== "mock" ||
      (config._plugins !== undefined && (!Array.isArray(config._plugins) || config._plugins.length !== 0)) ||
      (listen._host !== "127.0.0.1" && listen._host !== "::1") ||
      !Number.isSafeInteger(listen._port) || Number(listen._port) < 0 || Number(listen._port) > 65535) {
    throw new AgentAdkError("E_ADK_CONFIG", "Foundation requires explicit mock, zero plugins and loopback listener");
  }
  const folder = text(host._work_folder);
  if (!isAbsolute(folder)) {
    throw new AgentAdkError("E_ADK_CONFIG", "Foundation work folder must be absolute and new");
  }
  const address = listen._host as "127.0.0.1" | "::1";
  const port = listen._port as number;
  const channel = new FoundationChannel(text(channelConfig._id), adapter, turnPort);
  const agent = new FoundationAgent(text(config._name), channel, mockTextModel({ _text: text(model._text) }), adapter, turnPort);
  const lease = Symbol("adk-host");
  let state: AgentFoundationStatus["_state"] = "created";
  let node: XNode | undefined;
  let starting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  const turns = new Set<Promise<string>>();

  function closeResources(): Promise<void> {
    return cleanup ??= (async () => {
      try {
        try { await agent.stopChannels(); }
        finally {
          try {
            if (adapter) {
              let ownsGraph = false;
              try { ownsGraph = _x.getModule(agent._name) === agent; } catch { /* Not registered. */ }
              await adapter.close(ownsGraph);
            }
          }
          finally {
            try { await node?.stop(); }
            finally { if (resources) await resources.close(); }
          }
        }
      } finally {
        if (activeHost === lease) activeHost = undefined;
      }
    })();
  }

  function assertStarting(): void {
    if (state !== "starting") throw new AgentAdkError("E_ADK_CLOSED", "Foundation is closing");
  }

  function start(): Promise<void> {
    if (state === "closing" || state === "closed") {
      return Promise.reject(new AgentAdkError("E_ADK_CLOSED", "Use a fresh process after Foundation close"));
    }
    if (starting) return starting;
    state = "starting";
    starting = (async () => {
      try {
        if (activeHost || _x.isRunning()) {
          throw new AgentAdkError("E_ADK_HOST_IN_USE", "Foundation requires one host per fresh process");
        }
        activeHost = lease;
        if (resources) { await resources.preflight(); assertStarting(); }
        // Exclusive creation refuses existing stores, settings and symlinks.
        if (adapter) await adapter.prepareFolder(folder);
        else await mkdir(folder);
        assertStarting();
        if (resources) { await resources.materialize(); assertStarting(); }
        node = new XNode();
        await node.start({ _work_folder: folder, _host: address, _port: port,
          _web_settings: { "enable-wormhole": false, "enable-ssl": false },
          _modules: [agent], ...(resources?._system_xapps_path ? { _system_xapps_path: resources._system_xapps_path } : {}),
          ...(adapter ? { _system_xapps_path: adapter._system_xapps_path,
            ...(adapter._entity_sqlite ? { _entity_sqlite: adapter._entity_sqlite } : {}) } : {}) });
        assertStarting();
        await adapter?.afterStart();
        if (resources) await resources.afterStart();
        assertStarting();
        state = "ready";
      } catch (error) {
        try { await closeResources(); }
        catch { throw new AgentAdkError("E_ADK_CLEANUP", "Foundation startup and cleanup failed"); }
        finally { state = "closed"; }
        throw error;
      }
    })();
    return starting;
  }

  function close(): Promise<void> {
    if (closing) return closing;
    const wasStarting = state === "starting";
    state = "closing"; // Fence new fixture ingress immediately.
    const turnDrain = turnPort?.close();
    const stopped = wasStarting ? node?.stop() : undefined;
    closing = (async () => {
      try {
        await Promise.allSettled([starting, stopped]);
        await Promise.allSettled([...turns]);
        await turnDrain;
        await closeResources();
      } finally { state = "closed"; }
    })();
    return closing;
  }

  async function testTurn(input: { _text: string }): Promise<string> {
    if (state !== "ready") {
      throw new AgentAdkError("E_ADK_NOT_READY", "Foundation is not ready");
    }
    const turn = turnPort
      ? turnPort.turn(input, (message) => channel.turn(message._text, message))
      : adapter
      ? adapter.turn(input, (message) => channel.turn(message._text, message))
      : channel.turn(text(record(input, ["_text"])._text));
    turns.add(turn);
    void turn.then(() => turns.delete(turn), () => turns.delete(turn));
    return turn;
  }

  return Object.freeze({ start, close, testTurn,
    getStatus: () => Object.freeze({ _state: state,
      _agent: agent.getStatus(), _channels: agent.listChannels() }) });
}
