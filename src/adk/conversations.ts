import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _x, type XModule } from "@xpell/node";
import type { XAgentInboundMessage, XChannelInboundMessage } from "../XChannel.js";
import type { XAgentMessageContext } from "../XAgentMessageLifecycle.js";
import { AgentAdkError, composeFoundation, record, text,
  type AgentFoundationOptions, type AgentFoundation, type FoundationAdapter } from "./foundation.js";
import { createAgentApplicationScope, type AgentApplicationScope } from "./starter/persistence/AgentApplicationScope.js";
import { ConversationRepository, STARTER_APP_ID, STARTER_APP_ENV } from "./starter/persistence/ConversationRepository.js";
import { AgentPersistenceLifecycle } from "./starter/persistence/AgentPersistenceLifecycle.js";
import { ENTITY_IDS, type MessageRecord } from "./starter/persistence/types.js";
import { deterministicId } from "./starter/persistence/keys.js";
import { ConversationService } from "./starter/conversation/ConversationService.js";
import { ConversationContextManager, type BuiltConversationContext } from "./starter/conversation/ConversationContextManager.js";
import { displayedAssistantReply } from "./starter/conversation/UserVisibleReply.js";

export type DurableTurnInput = {
  _text: string;
  _external_conversation_id?: string;
  _external_user_id?: string;
  /** Supply the same ID and payload to test redelivery; omission creates a UUID. */
  _external_message_id?: string;
};
export type ConversationQuery = {
  _external_conversation_id?: string;
  _external_user_id?: string;
};
export type ConversationHistory = Readonly<{
  _conversation_id: string;
  _messages: readonly Readonly<{ _id: string; _role: "user" | "assistant"; _text: string }>[];
}>;
export type DurableAgentOptions = AgentFoundationOptions & {
  _conversations: {
    _provider: "sqlite";
    _instance_id: string;
    _application_scope: AgentApplicationScope;
    _history_limit: number;
    _context: {
      _max_context_tokens: number;
      _reserved_output_tokens: number;
      _safety_margin_tokens: number;
      _system_instructions: string;
    };
  };
};
export type DurableAgent = Omit<AgentFoundation, "testTurn"> & Readonly<{
  testTurn(input: DurableTurnInput): Promise<string>;
  getHistory(input?: ConversationQuery): Promise<ConversationHistory>;
  /** Bounded, read-only preview; does not persist the supplied current text. */
  getContext(input: ConversationQuery & { _current_text: string }): Promise<BuiltConversationContext>;
}>;

const ENTITIES = [ENTITY_IDS.PARTICIPANT, ENTITY_IDS.CHANNEL_IDENTITY, ENTITY_IDS.CONVERSATION, ENTITY_IDS.MESSAGE] as const;
const ASSETS = ["app.json", ...ENTITIES.map((id) => `entities/${id}.json`)];
const SYSTEM_APPS = fileURLToPath(new URL("../../adk-system-xapps/", import.meta.url));
const MARKER = ".adk-conversations.json";

function failure(code: string, message: string): AgentAdkError { return new AgentAdkError(code, message); }
function query(input: unknown): Required<ConversationQuery> {
  const v = record(input, ["_external_conversation_id", "_external_user_id"]);
  return { _external_conversation_id: v._external_conversation_id === undefined ? "mock-conversation" : text(v._external_conversation_id),
    _external_user_id: v._external_user_id === undefined ? "mock-participant" : text(v._external_user_id) };
}

class ConversationProfile implements FoundationAdapter {
  readonly _system_xapps_path = SYSTEM_APPS;
  readonly #repository: ConversationRepository;
  readonly #service: ConversationService;
  readonly #context: ConversationContextManager;
  readonly _lifecycle: AgentPersistenceLifecycle;
  readonly #scope: AgentApplicationScope;
  readonly #identity: Record<string, unknown>;
  readonly #channelId: string;
  readonly #historyLimit: number;
  readonly #queues = new Map<string, Promise<string>>();
  readonly #reads = new Set<Promise<unknown>>();
  #closing = false;

  constructor(options: DurableAgentOptions) {
    const c = record(options._conversations, ["_provider", "_instance_id", "_application_scope", "_history_limit", "_context"]);
    if (c._provider !== "sqlite" || !Number.isSafeInteger(c._history_limit) || Number(c._history_limit) < 1 || Number(c._history_limit) > 200) {
      throw failure("E_ADK_CONVERSATION_CONFIG", "SQLite profile requires a history limit from 1 to 200");
    }
    const scope = record(c._application_scope, ["_env", "_app_id"]);
    this.#scope = createAgentApplicationScope(scope as AgentApplicationScope);
    const bounds = record(c._context, ["_max_context_tokens", "_reserved_output_tokens", "_safety_margin_tokens", "_system_instructions"]);
    this.#channelId = text(record(options._channel, ["_type", "_id"])._id);
    this.#historyLimit = c._history_limit as number;
    this.#identity = { _profile: "adk-conversations-sqlite/1", _instance_id: text(c._instance_id),
      _application_scope: this.#scope, _agent_name: text(options._name), _channel_id: this.#channelId };
    this.#repository = new ConversationRepository({ _application_scope: this.#scope });
    this.#service = new ConversationService({ _repository: this.#repository });
    this._lifecycle = new AgentPersistenceLifecycle({ _service: this.#service });
    this.#context = new ConversationContextManager({ _conversation_service: this.#service,
      _max_context_tokens: bounds._max_context_tokens as number,
      _reserved_output_tokens: bounds._reserved_output_tokens as number,
      _safety_margin_tokens: bounds._safety_margin_tokens as number,
      _system_instructions: text(bounds._system_instructions) });
  }

  async prepareFolder(folder: string): Promise<void> {
    const hash = createHash("sha256");
    for (const asset of ASSETS) hash.update(await readFile(join(SYSTEM_APPS, STARTER_APP_ID, asset)));
    const marker = { ...this.#identity, _schema_sha256: hash.digest("hex") };
    const expected = JSON.stringify(marker);
    let created = false;
    try { await mkdir(folder); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (created) {
      await writeFile(join(folder, MARKER), expected + "\n", { flag: "wx", mode: 0o600 });
      return;
    }
    try {
      const directory = await lstat(folder);
      const file = await lstat(join(folder, MARKER));
      if (!directory.isDirectory() || directory.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.size > 65536 ||
          JSON.stringify(JSON.parse(await readFile(join(folder, MARKER), "utf8"))) !== expected) throw new Error("profile mismatch");
    } catch {
      throw failure("E_ADK_PROFILE_MISMATCH", "Existing work folder is not this instance/application profile");
    }
  }

  async afterStart(): Promise<void> {
    const actual = await this.#repository.listEntityIds();
    if (actual.length !== ENTITIES.length || ENTITIES.some((id) => !actual.includes(id))) {
      throw failure("E_ADK_SCHEMA", "Expected only the four protected conversation entities");
    }
    for (const id of ENTITIES) if (await this.#repository.storageProvider(id) !== "sqlite") {
      throw failure("E_ADK_STORAGE", "Durable conversation entities require SQLite");
    }
    // Existing conservative reconciliation only: never generate or resend at startup.
    await this.#repository.reconcileInterruptedOutbound(new Date());
  }

  async beforeModel(context: XAgentMessageContext, message: XAgentInboundMessage): Promise<void> {
    const turn = this._lifecycle.requireInboundTurn(context);
    await this.#context.build({ _turn: turn, _actor: this.#service.resolveExternalActor(turn), _current_text: message._text });
  }

  turn(input: unknown, invoke: (message: XChannelInboundMessage) => Promise<string>): Promise<string> {
    const v = record(input, ["_text", "_external_conversation_id", "_external_user_id", "_external_message_id"]);
    const ids = query({ _external_conversation_id: v._external_conversation_id, _external_user_id: v._external_user_id });
    const message: XChannelInboundMessage = { ...ids, _text: text(v._text),
      _external_message_id: v._external_message_id === undefined ? randomUUID() : text(v._external_message_id) };
    const key = ids._external_conversation_id;
    const prior = this.#queues.get(key) ?? Promise.resolve("");
    const turn = prior.catch(() => "").then(() => invoke(message));
    this.#queues.set(key, turn);
    const clear = () => { if (this.#queues.get(key) === turn) this.#queues.delete(key); };
    void turn.then(clear, clear);
    return turn;
  }

  async replay(message: XChannelInboundMessage): Promise<string> {
    const inbound = await this.#repository.findMessageByDedupeKey(this.#repository.inboundDedupeKey(
      this.#channelId, message._external_conversation_id, message._external_message_id));
    const reply = inbound ? await this.#repository.findMessageByDedupeKey(this.#repository.outboundDedupeKey(
      this.#channelId, message._external_conversation_id, inbound._id)) : null;
    if (inbound?._delivery_state === "processed" && reply?._delivery_state === "accepted") return displayedAssistantReply(reply._text);
    throw failure("E_ADK_REPLAY_UNCERTAIN", "Persisted work has no proven accepted reply; it will not be repeated");
  }

  private async lookup(input: Required<ConversationQuery>) {
    const conversation = await this.#repository.findConversation({ _source_type: "channel", _source_id: this.#channelId,
      _source_conversation_id: input._external_conversation_id });
    const identity = await this.#repository.findChannelIdentity(this.#channelId, input._external_user_id);
    if (!conversation || !identity || !conversation._participant_ids.includes(identity._participant_id)) {
      throw failure("E_ADK_CONVERSATION_NOT_FOUND", "Conversation is not linked to this scoped mock identity");
    }
    return { conversation, identity };
  }

  private read<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(failure("E_ADK_CLOSED", "Conversation profile is closing"));
    const p = fn(); this.#reads.add(p);
    void p.then(() => this.#reads.delete(p), () => this.#reads.delete(p));
    return p;
  }

  history(input: ConversationQuery): Promise<ConversationHistory> {
    return this.read(async () => {
      const { conversation } = await this.lookup(query(input));
      const records = await this.#repository.listRecentMessageHistory({ _conversation_id: conversation._id, _limit: this.#historyLimit });
      const messages = records.reverse().flatMap<ConversationHistory["_messages"][number]>((m: MessageRecord) => {
        if (m._direction === "inbound" && m._delivery_state === "processed") return [{ _id: m._id, _role: "user" as const, _text: m._text }];
        if (m._direction === "outbound" && m._delivery_state === "accepted") return [{ _id: m._id, _role: "assistant" as const, _text: displayedAssistantReply(m._text) }];
        return [];
      });
      return Object.freeze({ _conversation_id: conversation._id, _messages: Object.freeze(messages.map((m) => Object.freeze(m))) });
    });
  }

  context(input: ConversationQuery & { _current_text: string }): Promise<BuiltConversationContext> {
    return this.read(async () => {
      const v = record(input, ["_external_conversation_id", "_external_user_id", "_current_text"]);
      const ids = query({ _external_conversation_id: v._external_conversation_id, _external_user_id: v._external_user_id });
      const { conversation, identity } = await this.lookup(ids);
      const turn = Object.freeze({ _application_scope_key: this.#repository.applicationScopeKey,
        _conversation_id: conversation._id, _participant_id: identity._participant_id, _channel_identity_id: identity._id,
        _source_type: "channel" as const, _source_id: this.#channelId, _source_conversation_id: ids._external_conversation_id,
        _inbound_message_id: deterministicId("adk-context-preview", conversation._id) });
      return this.#context.build({ _turn: turn, _actor: this.#service.resolveExternalActor(turn), _current_text: text(v._current_text) });
    });
  }

  async close(ownsGraph: boolean): Promise<void> {
    this.#closing = true;
    await Promise.allSettled([...this.#reads]);
    if (!ownsGraph) return;
    let manager: XModule | undefined;
    try { manager = _x.getModule("entity-manager"); } catch { return; }
    if (!manager) return;
    // Internal disposal only. The captured, ownership-checked module command
    // dispatcher remains usable after XNode fences Core on partial startup.
    // unregister disposes SQLite handles and preserves tables/artifact files.
    const failures: unknown[] = [];
    for (const id of ENTITIES) {
      try {
        const command = { _module: "entity-manager", _op: "unregister",
          _params: { _app_id: STARTER_APP_ID, _env: STARTER_APP_ENV, _entity_id: id } };
        const response = await (_x.isRunning() ? _x.execute(command) : manager.execute(command));
        if (!response?._ok) throw failure("E_ADK_DISPOSE", "Conversation registration did not close cleanly");
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw failure("E_ADK_DISPOSE", "Conversation providers did not close cleanly");
  }
}

/** Opt-in SQLite conversation profile. Existing createAgent remains mock-only. */
export function createDurableAgent(options: DurableAgentOptions): DurableAgent {
  const v = record(options, ["_name", "_model", "_channel", "_host", "_plugins", "_conversations"]);
  // Validate all Phase 1 configuration before any profile I/O.
  const { _conversations: _ignored, ...baseOptions } = v;
  const profile = new ConversationProfile(options);
  const base = composeFoundation(baseOptions as AgentFoundationOptions, profile);
  const ready = () => {
    if (base.getStatus()._state !== "ready") throw failure("E_ADK_NOT_READY", "Durable Agent is not ready");
  };
  return Object.freeze({ ...base,
    getHistory: async (input: ConversationQuery = {}) => { ready(); return profile.history(input); },
    getContext: async (input: ConversationQuery & { _current_text: string }) => { ready(); return profile.context(input); } });
}
