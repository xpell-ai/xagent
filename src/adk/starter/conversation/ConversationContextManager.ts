import type { XAIMessage } from "@xpell/node";
import { hasPlanningEnvelope } from "./UserVisibleReply.js";

import {
  toModelSafeActorContext,
  type ActorContext,
  type ModelSafeActorContext,
} from "../actor/ActorContext.js";
import type {
  ConversationService,
  PersistedInboundConversationTurn,
} from "./ConversationService.js";
import type { MessageRecord } from "../persistence/types.js";
import {
  responseLanguageInstruction,
  type ResponseLanguage,
} from "./ResponseLanguagePolicy.js";

const HISTORY_PAGE_SIZE = 64;
const MESSAGE_OVERHEAD_TOKENS = 8;
const REQUEST_OVERHEAD_TOKENS = 16;

export type TokenEstimator = (value: string) => number;

export type ApplicationContextInput = Readonly<{
  _actor: ActorContext;
  _conversation: PersistedInboundConversationTurn;
  _conversation_id: string;
  _inbound_message_id: string;
  _current_text: string;
}>;

export type ApplicationContextProvider = (
  input: ApplicationContextInput,
) => unknown | Promise<unknown>;

export type ConversationContextManagerOptions = {
  _conversation_service: ConversationService;
  _task?: string;
  _max_context_tokens: number;
  _reserved_output_tokens: number;
  _safety_margin_tokens: number;
  _system_instructions: string;
  _agent_context?: ApplicationContextProvider;
  _application_context?: ApplicationContextProvider;
  _estimate_tokens?: TokenEstimator;
};

export type BuiltConversationContext = Readonly<{
  _task: string;
  _system: string;
  _context: Readonly<{
    _actor: ModelSafeActorContext;
    _agent?: unknown;
    _application?: unknown;
  }>;
  _messages: readonly XAIMessage[];
  _history_message_ids: readonly string[];
  _estimated_input_tokens: number;
  _input_budget_tokens: number;
  _reserved_output_tokens: number;
}>;

export class ConversationContextError extends Error {
  readonly _code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConversationContextError";
    this._code = code;
  }
}

/** Conservative deterministic fallback: UTF-8 bytes / 3, rounded up. */
export function estimateTokensConservatively(value: string): number {
  if (value.length === 0) return 0;
  return Math.max(1, Math.ceil(new TextEncoder().encode(value).length / 3));
}

function textMessage(role: "user" | "assistant", text: string): XAIMessage {
  return {
    _role: role,
    _content: [{ _type: "text", _text: text }],
  };
}

function historyMessage(record: MessageRecord): XAIMessage | undefined {
  if (record._direction === "inbound" && record._delivery_state === "processed") {
    return textMessage("user", record._text);
  }
  if (record._direction === "outbound" && record._delivery_state === "accepted") {
    if (hasPlanningEnvelope(record._text)) return undefined;
    return textMessage("assistant", record._text);
  }
  return undefined;
}

function jsonForBudget(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? "null";
  } catch {
    throw new ConversationContextError(
      "E_STARTER_APPLICATION_CONTEXT_INVALID",
      "Application context must be JSON-compatible",
    );
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConversationContextError(
      "E_STARTER_CONTEXT_CONFIG_INVALID",
      `${field} must be a positive integer`,
    );
  }
  return value;
}

export class ConversationContextManager {
  readonly #service: ConversationService;
  readonly #task: string;
  readonly #maxContextTokens: number;
  readonly #reservedOutputTokens: number;
  readonly #safetyMarginTokens: number;
  readonly #systemInstructions: string;
  readonly #agentContext?: ApplicationContextProvider;
  readonly #applicationContext?: ApplicationContextProvider;
  readonly #estimate: TokenEstimator;

  constructor(options: ConversationContextManagerOptions) {
    this.#service = options._conversation_service;
    this.#task = options._task?.trim() || "chat";
    this.#maxContextTokens = positiveInteger(
      options._max_context_tokens,
      "_max_context_tokens",
    );
    this.#reservedOutputTokens = positiveInteger(
      options._reserved_output_tokens,
      "_reserved_output_tokens",
    );
    this.#safetyMarginTokens = positiveInteger(
      options._safety_margin_tokens,
      "_safety_margin_tokens",
    );
    this.#systemInstructions = options._system_instructions.trim();
    if (!this.#systemInstructions) {
      throw new ConversationContextError(
        "E_STARTER_CONTEXT_CONFIG_INVALID",
        "_system_instructions must be non-empty",
      );
    }
    if (
      this.#reservedOutputTokens + this.#safetyMarginTokens >=
      this.#maxContextTokens
    ) {
      throw new ConversationContextError(
        "E_STARTER_CONTEXT_CONFIG_INVALID",
        "Output reserve and safety margin must leave an input budget",
      );
    }
    this.#agentContext = options._agent_context;
    this.#applicationContext = options._application_context;
    this.#estimate = options._estimate_tokens ?? estimateTokensConservatively;
  }

  async build(input: {
    _turn: PersistedInboundConversationTurn;
    _actor: ActorContext;
    _current_text: string;
    _response_language?: ResponseLanguage;
  }): Promise<BuiltConversationContext> {
    this.#service.assertConversationScope(input._turn);
    if (!input._current_text.trim()) {
      throw new ConversationContextError(
        "E_STARTER_CURRENT_MESSAGE_INVALID",
        "Current message must be non-empty",
      );
    }

    const providerInput = {
      _actor: input._actor,
      _conversation: input._turn,
      _conversation_id: input._turn._conversation_id,
      _inbound_message_id: input._turn._inbound_message_id,
      _current_text: input._current_text,
    } as const;
    const [agent, application] = await Promise.all([
      this.#agentContext?.(providerInput),
      this.#applicationContext?.(providerInput),
    ]);
    const context = Object.freeze({
      _actor: toModelSafeActorContext(input._actor),
      ...(agent === undefined ? {} : { _agent: agent }),
      ...(application === undefined ? {} : { _application: application }),
    });
    const inputBudget =
      this.#maxContextTokens -
      this.#reservedOutputTokens -
      this.#safetyMarginTokens;
    const currentMessage = textMessage("user", input._current_text);
    const systemInstructions = input._response_language
      ? `${this.#systemInstructions}\n\n${responseLanguageInstruction(input._response_language)}`
      : this.#systemInstructions;
    const fixedTokens =
      REQUEST_OVERHEAD_TOKENS +
      MESSAGE_OVERHEAD_TOKENS +
      this.#estimate(systemInstructions) +
      this.#estimate(jsonForBudget(context)) +
      this.#estimate(input._current_text);

    if (fixedTokens > inputBudget) {
      throw new ConversationContextError(
        "E_STARTER_CONTEXT_BUDGET_EXCEEDED",
        "System policy, actor/application context, and current message exceed the input budget",
      );
    }

    let remaining = inputBudget - fixedTokens;
    let beforeHistoryKey: string | undefined;
    let exhausted = false;
    const selected: Array<{ _id: string; _message: XAIMessage; _tokens: number }> = [];

    while (!exhausted) {
      const page = await this.#service.listRecentMessageHistory({
        _conversation_id: input._turn._conversation_id,
        ...(beforeHistoryKey ? { _before_history_key: beforeHistoryKey } : {}),
        _limit: HISTORY_PAGE_SIZE,
      });
      if (page.length === 0) break;

      for (const record of page) {
        if (record._id === input._turn._inbound_message_id) continue;
        const mapped = historyMessage(record);
        if (!mapped) continue;
        const tokens = MESSAGE_OVERHEAD_TOKENS + this.#estimate(record._text);
        if (tokens > remaining) {
          exhausted = true;
          break;
        }
        selected.push({ _id: record._id, _message: mapped, _tokens: tokens });
        remaining -= tokens;
      }

      if (exhausted || page.length < HISTORY_PAGE_SIZE) break;
      beforeHistoryKey = page.at(-1)?._history_key;
      if (!beforeHistoryKey) break;
    }

    selected.reverse();
    const historyTokens = selected.reduce((total, item) => total + item._tokens, 0);
    return Object.freeze({
      _task: this.#task,
      _system: systemInstructions,
      _context: context,
      _messages: Object.freeze([
        ...selected.map((item) => item._message),
        currentMessage,
      ]),
      _history_message_ids: Object.freeze(selected.map((item) => item._id)),
      _estimated_input_tokens: fixedTokens + historyTokens,
      _input_budget_tokens: inputBudget,
      _reserved_output_tokens: this.#reservedOutputTokens,
    });
  }
}
