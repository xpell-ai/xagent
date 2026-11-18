import {
  XError,
  _xu,
  type XAIToolDefinition,
} from "@xpell/node";

import type { ActorContext } from "../actor/ActorContext.js";
import type { PersistedInboundConversationTurn } from "../conversation/ConversationService.js";
import type { ResponseLanguage } from "../conversation/ResponseLanguagePolicy.js";

export const STARTER_CAPABILITY_ERROR_CODES = {
  INVALID_DEFINITION: "E_STARTER_CAPABILITY_INVALID_DEFINITION",
  UNKNOWN: "E_STARTER_CAPABILITY_UNKNOWN",
  NOT_ALLOWED: "E_STARTER_CAPABILITY_NOT_ALLOWED",
  ARGUMENTS_INVALID: "E_STARTER_CAPABILITY_ARGUMENTS_INVALID",
  UNSUPPORTED: "E_STARTER_CAPABILITY_UNSUPPORTED",
  HANDLER_FAILED: "E_STARTER_CAPABILITY_HANDLER_FAILED",
  RESULT_INVALID: "E_STARTER_CAPABILITY_RESULT_INVALID",
  TOOL_CALL_INVALID: "E_STARTER_CAPABILITY_TOOL_CALL_INVALID",
  TOOL_CALL_COUNT: "E_STARTER_CAPABILITY_TOOL_CALL_COUNT",
  LOOP_LIMIT: "E_STARTER_CAPABILITY_LOOP_LIMIT",
} as const;

export type StarterCapabilityErrorCode =
  (typeof STARTER_CAPABILITY_ERROR_CODES)[keyof typeof STARTER_CAPABILITY_ERROR_CODES];

export class StarterCapabilityError extends XError {
  constructor(code: StarterCapabilityErrorCode, message: string) {
    super(code, message, { _level: "warn" });
    this.name = "StarterCapabilityError";
  }
}

export type AgentCapabilityEffect = "read" | "side_effect";
export type AgentCapabilityConfirmation = "none" | "required";

export type EffectiveAgentCapability = Readonly<{
  _id: string;
  _description: string;
  _confirmation?: AgentCapabilityConfirmation;
}>;

/** Trusted presentation only. Never exposed as a tool or used to authorize work. */
export type AgentCapabilityReplyInput = Readonly<{
  _phase: "proposal" | "result" | "preparation_denied";
  _result: unknown;
  _current_text: string;
  _response_language: ResponseLanguage;
  /** Private prepared proposal; never serialized into model context. */
  _proposal?: PreparedAgentAction;
}>;

export type PreparedAgentAction = Readonly<{
  _arguments: Readonly<Record<string, unknown>>;
  _authorized_scope: Readonly<Record<string, unknown>>;
  _confirmation_summary: string;
}>;

export type AgentCapabilityPreparationInput = Readonly<{
  _arguments: Readonly<Record<string, unknown>>;
  _actor: ActorContext;
  _conversation: PersistedInboundConversationTurn;
}>;

/** Creation-only request check. Confirmation re-preparation never calls this hook. */
export type AgentPreparationRequestInput = AgentCapabilityPreparationInput & Readonly<{
  _current_text: string;
  /** Bounded semantic check of this original turn; never an authorization decision. */
  _assess_request: (operation: string) => Promise<boolean>;
}>;

export type AgentActionExecutionContext = Readonly<{
  _id: string;
  _idempotency_key: string;
  _authorized_scope: Readonly<Record<string, unknown>>;
  _request_message_id: string;
}>;

export type AgentSideEffectOutcome =
  | Readonly<{
      _status: "succeeded";
      _result: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      _status: "failed";
      _failure_code: string;
      _result?: Readonly<Record<string, unknown>>;
    }>;

export type AgentCapabilityHandlerInput = Readonly<{
  _arguments: Readonly<Record<string, unknown>>;
  _actor: ActorContext;
  _conversation: PersistedInboundConversationTurn;
  _effective_capabilities: readonly EffectiveAgentCapability[];
  _action?: AgentActionExecutionContext;
}>;

export type AgentCapability<TResult = unknown> = Readonly<{
  _id: string;
  _description: string;
  _input_schema: Readonly<Record<string, unknown>>;
  _effect: AgentCapabilityEffect;
  _confirmation: AgentCapabilityConfirmation;
  /** Current application state must be retrieved before answering a matching request. Reads only. */
  _authoritative?: boolean;
  /** Trusted, product-owned intent guard for a Router `normal` misclassification. */
  _matches_request?: (currentText: string) => boolean;
  _can_prepare?: (input: AgentPreparationRequestInput) => boolean | Promise<boolean>;
  _input_question?: (language: ResponseLanguage) => string;
  _render_reply?: (input: AgentCapabilityReplyInput) => string | undefined;
  /** Required, stable implementation revision for side-effect capabilities. */
  _revision?: string;
  /** Required for side effects; derives trusted scope and the exact proposal. */
  _prepare_action?: (
    input: AgentCapabilityPreparationInput,
  ) => PreparedAgentAction | Promise<PreparedAgentAction>;
  _handler: (
    input: AgentCapabilityHandlerInput,
  ) => TResult | Promise<TResult>;
}>;

export function assertAgentCapability(
  value: AgentCapability,
): AgentCapability {
  const basicInvalid =
    !_xu.is_non_empty_string(value?._id) ||
    !_xu.is_non_empty_string(value?._description) ||
    !_xu.is_plain_object(value?._input_schema) ||
    (value?._effect !== "read" && value?._effect !== "side_effect") ||
    (value?._confirmation !== "none" && value?._confirmation !== "required") ||
    (value?._authoritative !== undefined && typeof value._authoritative !== "boolean") ||
    (value?._matches_request !== undefined && typeof value._matches_request !== "function") ||
    (value?._input_question !== undefined && typeof value._input_question !== "function") ||
    (value?._can_prepare !== undefined &&
      (typeof value._can_prepare !== "function" || value._effect !== "side_effect")) ||
    (value?._render_reply !== undefined && typeof value._render_reply !== "function") ||
    (value?._authoritative === true &&
      (value._effect !== "read" || value._confirmation !== "none")) ||
    typeof value?._handler !== "function";
  const sideEffectInvalid =
    value?._effect === "side_effect" &&
    (value?._confirmation !== "required" ||
      !_xu.is_non_empty_string(value?._revision) ||
      typeof value?._prepare_action !== "function");
  if (basicInvalid || sideEffectInvalid) {
    throw new StarterCapabilityError(
      STARTER_CAPABILITY_ERROR_CODES.INVALID_DEFINITION,
      "Agent capability definition is invalid",
    );
  }
  return value;
}

export function capabilityToXAITool(
  capability: AgentCapability,
): XAIToolDefinition {
  const description =
    capability._effect === "side_effect" &&
      capability._confirmation === "required"
      ? `${capability._description}\n\nAction protocol: Call this tool when the user requests the described action and all required arguments are known. Calling it does not execute the side effect; it durably prepares the proposed Action, and the Agent framework will request user confirmation afterward. Do not ask the user for confirmation before calling this tool. If required arguments are missing or ambiguous, ask only for the missing information and do not call this tool yet.`
      : capability._description;
  return {
    _name: capability._id,
    _description: description,
    _input_schema: capability._input_schema as Record<string, unknown>,
  };
}

const SUPPORTED_STRING_SCHEMA_KEYS = new Set([
  "type",
  "description",
  "minLength",
  "maxLength",
]);

type SupportedStringSchema = Readonly<{
  type: "string";
  description?: string;
  minLength?: number;
  maxLength?: number;
}>;

function readSupportedStringSchema(value: unknown): SupportedStringSchema {
  if (
    !_xu.is_plain_object(value) ||
    value.type !== "string" ||
    (value.description !== undefined && typeof value.description !== "string") ||
    Object.keys(value).some((key) => !SUPPORTED_STRING_SCHEMA_KEYS.has(key))
  ) {
    throw new StarterCapabilityError(
      STARTER_CAPABILITY_ERROR_CODES.UNSUPPORTED,
      "Capability input contract is not supported by V1",
    );
  }

  const minLength = value.minLength;
  const maxLength = value.maxLength;
  if (
    (minLength !== undefined &&
      (!Number.isSafeInteger(minLength) || minLength < 0)) ||
    (maxLength !== undefined &&
      (!Number.isSafeInteger(maxLength) || maxLength < 0)) ||
    (minLength !== undefined &&
      maxLength !== undefined &&
      minLength > maxLength)
  ) {
    throw new StarterCapabilityError(
      STARTER_CAPABILITY_ERROR_CODES.UNSUPPORTED,
      "Capability input contract is not supported by V1",
    );
  }

  return value as SupportedStringSchema;
}

/**
 * V1 accepts closed object schemas with either no properties or bounded string
 * properties. This keeps application validation deterministic without adding a
 * second general-purpose schema runtime.
 */
export function validateCapabilityArguments(
  capability: AgentCapability,
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (!_xu.is_plain_object(value)) {
    throw new StarterCapabilityError(
      STARTER_CAPABILITY_ERROR_CODES.ARGUMENTS_INVALID,
      "Capability arguments are invalid",
    );
  }

  const schema = capability._input_schema;
  const properties = schema.properties;
  const required = schema.required;
  if (
    schema.type !== "object" ||
    !_xu.is_plain_object(properties) ||
    schema.additionalProperties !== false ||
    (required !== undefined && !Array.isArray(required))
  ) {
    throw new StarterCapabilityError(
      STARTER_CAPABILITY_ERROR_CODES.UNSUPPORTED,
      "Capability input contract is not supported by V1",
    );
  }

  const propertySchemas = new Map(
    Object.entries(properties).map(([key, propertySchema]) => [
      key,
      readSupportedStringSchema(propertySchema),
    ]),
  );
  const allowedKeys = new Set(propertySchemas.keys());
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new StarterCapabilityError(
      STARTER_CAPABILITY_ERROR_CODES.ARGUMENTS_INVALID,
      "Capability arguments are invalid",
    );
  }

  const requiredKeys = required ?? [];
  if (
    requiredKeys.some((key) => typeof key !== "string") ||
    new Set(requiredKeys).size !== requiredKeys.length ||
    requiredKeys.some((key) => !allowedKeys.has(key))
  ) {
    throw new StarterCapabilityError(
      STARTER_CAPABILITY_ERROR_CODES.UNSUPPORTED,
      "Capability input contract is not supported by V1",
    );
  }

  if (requiredKeys.some((key) => !Object.hasOwn(value, key))) {
    throw new StarterCapabilityError(
      STARTER_CAPABILITY_ERROR_CODES.ARGUMENTS_INVALID,
      "Capability arguments are invalid",
    );
  }

  for (const [key, propertySchema] of propertySchemas) {
    if (!Object.hasOwn(value, key)) continue;
    const propertyValue = value[key];
    if (
      typeof propertyValue !== "string" ||
      (propertySchema.minLength !== undefined &&
        propertyValue.length < propertySchema.minLength) ||
      (propertySchema.maxLength !== undefined &&
        propertyValue.length > propertySchema.maxLength)
    ) {
      throw new StarterCapabilityError(
        STARTER_CAPABILITY_ERROR_CODES.ARGUMENTS_INVALID,
        "Capability arguments are invalid",
      );
    }
  }

  return Object.freeze({ ...value });
}
