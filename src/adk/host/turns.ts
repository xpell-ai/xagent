import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { ReadToolError } from "../tools.js";
import type { FoundationTurns } from "../foundation.js";
import type { XAgentMessageContext, XAgentMessageLifecycle } from "../../XAgentMessageLifecycle.js";
import type { XAgentInboundMessage, XChannelOutboundMessage } from "../../XChannel.js";
import { AgentHostError, data, fail, type AgentHostErrorCode } from "./resources.js";

const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const addAbort = EventTarget.prototype.addEventListener, removeAbort = EventTarget.prototype.removeEventListener;

/** @experimental Trusted local composition; correlation is not an authenticated identity. */
export type HostTurnRequest = Readonly<{
  _turn_id: string;
  _source: "synthetic-local";
  _text: string;
  _signal: AbortSignal;
}>;
/** @experimental D.1: reviewed in-memory orchestration, synchronous T1 policy/handler only. */
export type HostTurnDelegate = Readonly<{
  _run(input: HostTurnRequest): Promise<string>;
  _authorize(input: HostTurnRequest & Readonly<{ _phase: "run" | "reply" }>): boolean | Promise<boolean>;
  _limits: Readonly<{ _timeout_ms: number; _max_input_bytes: number; _max_output_bytes: number }>;
}>;
type Operation = {
  request: HostTurnRequest; controller: AbortController;
  deadline: number; invoked: boolean; replied: boolean; authorized: boolean;
  context?: XAgentMessageContext; result?: string; error?: AgentHostError;
  actual?: Promise<string>; stop(code: AgentHostErrorCode): void;
};
function integer(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) return fail("E_ADK_HOST_CONFIG");
  return value as number;
}
function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > max)
    return fail("E_ADK_HOST_TURN_LIMIT");
  return value;
}
function safe(error: unknown): AgentHostError {
  if (error && typeof error === "object" && !types.isProxy(error)) {
    const prototype = Object.getPrototypeOf(error), code = Object.getOwnPropertyDescriptor(error, "_code")?.value;
    if (prototype === AgentHostError.prototype && ["E_ADK_HOST_TURN_DENIED", "E_ADK_HOST_TURN_BUSY", "E_ADK_HOST_TURN_CANCELLED",
      "E_ADK_HOST_TURN_TIMEOUT", "E_ADK_HOST_TURN_LIMIT", "E_ADK_HOST_TURN_FAILED"].includes(code)) return error as AgentHostError;
    if (prototype === ReadToolError.prototype && code === "E_ADK_TOOL_DENIED") return new AgentHostError("E_ADK_HOST_TURN_DENIED");
  }
  return new AgentHostError("E_ADK_HOST_TURN_FAILED");
}

/** Package-private operation owner; never exports a Node, registry or independently closable Agent. */
export function turnController(value: unknown): Readonly<{
  port: FoundationTurns;
  run(text: unknown, signal: AbortSignal | undefined, invoke: () => Promise<string>): Promise<string>;
}> {
  const v = data(value, ["_run", "_authorize", "_limits"]);
  if (typeof v._run !== "function" || typeof v._authorize !== "function") return fail("E_ADK_HOST_CONFIG");
  const raw = data(v._limits, ["_timeout_ms", "_max_input_bytes", "_max_output_bytes"]);
  const timeout = integer(raw._timeout_ms, 5000), inputBytes = integer(raw._max_input_bytes, 4096), outputBytes = integer(raw._max_output_bytes, 8192);
  const run = v._run as HostTurnDelegate["_run"], policy = v._authorize as HostTurnDelegate["_authorize"];
  let active: Operation | undefined, closed = false;
  let closing: Promise<void> | undefined;
  const contexts = new WeakMap<XAgentMessageContext, Operation>();
  function check(op: Operation): void {
    if (closed) op.stop("E_ADK_HOST_TURN_CANCELLED");
    if (performance.now() >= op.deadline) op.stop("E_ADK_HOST_TURN_TIMEOUT");
    if (op.error) throw op.error;
    if (active !== op) return fail("E_ADK_HOST_TURN_DENIED");
  }
  function own(context: XAgentMessageContext): Operation {
    const op = contexts.get(context);
    if (!op) return fail("E_ADK_HOST_TURN_DENIED");
    check(op); return op;
  }
  async function authorize(op: Operation, phase: "run" | "reply"): Promise<void> {
    check(op);
    let decision: unknown;
    try { decision = await policy(Object.freeze({ ...op.request, _phase: phase })); }
    catch { check(op); return fail("E_ADK_HOST_TURN_DENIED"); }
    check(op);
    if (decision !== true) return fail("E_ADK_HOST_TURN_DENIED");
  }
  const matches = (op: Operation, message: Pick<XAgentInboundMessage, "_external_message_id" | "_external_user_id" | "_external_conversation_id" | "_text">) =>
    message._external_message_id === op.request._turn_id && message._external_user_id === "mock-participant" &&
    message._external_conversation_id === "mock-conversation" && message._text === op.request._text;
  const port: FoundationTurns = Object.freeze({
    _lifecycle: Object.freeze<XAgentMessageLifecycle>({
      beforeInbound(context, message) {
        const op = active;
        // Only the private admitted mock delivery may acquire this execution context.
        if (!op || !op.invoked || op.context || !matches(op, message)) return fail("E_ADK_HOST_TURN_DENIED");
        check(op); op.context = context; contexts.set(context, op);
      },
      async beforeChannelSend(context, message) {
        const op = own(context);
        try {
          if (op.replied || message._reply_to_external_message_id !== op.request._turn_id || message._text !== op.result)
            return fail("E_ADK_HOST_TURN_DENIED");
          await authorize(op, "reply"); check(op); op.authorized = true;
        } catch (error) { op.error ??= safe(error); throw op.error; }
      },
    }),
    async turn(input, invoke) {
      const op = active, text = data(input, ["_text"])._text;
      if (!op || op.invoked || text !== op.request._text) return fail("E_ADK_HOST_TURN_DENIED");
      check(op); op.invoked = true;
      try {
        const answer = await invoke({ _external_user_id: "mock-participant", _external_conversation_id: "mock-conversation",
          _external_message_id: op.request._turn_id, _text: op.request._text });
        check(op);
        if (!op.replied || answer !== op.result) return fail("E_ADK_HOST_TURN_FAILED");
        return answer;
      } catch (error) { op.error ??= safe(error); throw op.error; }
    },
    async beforeModel(context) {
      const op = own(context);
      try {
        await authorize(op, "run");
        const result = await run(op.request); check(op);
        op.result = boundedText(result, outputBytes); return op.result;
      } catch (error) { op.error ??= safe(error); throw op.error; }
    },
    beforeReply(message: XChannelOutboundMessage) {
      const op = active;
      if (!op) return fail("E_ADK_HOST_TURN_DENIED");
      check(op);
      if (!op.authorized || op.replied || message._reply_to_external_message_id !== op.request._turn_id ||
          message._external_conversation_id !== "mock-conversation" || message._text !== op.result)
        return fail("E_ADK_HOST_TURN_DENIED");
      // Synchronous last fence: no await between this check and the mock Channel acceptance.
      op.replied = true;
    },
    close() {
      if (closing) return closing;
      closed = true; active?.stop("E_ADK_HOST_TURN_CANCELLED");
      return closing = Promise.allSettled(active?.actual ? [active.actual] : []).then(() => undefined);
    },
  });
  return Object.freeze({ port,
    run(text: unknown, signal: AbortSignal | undefined, invoke: () => Promise<string>) {
      if (closed) return Promise.reject(new AgentHostError("E_ADK_HOST_TURN_CANCELLED"));
      if (active) return Promise.reject(new AgentHostError("E_ADK_HOST_TURN_BUSY"));
      if (signal !== undefined && (types.isProxy(signal) || !(signal instanceof AbortSignal))) return fail("E_ADK_HOST_CONFIG");
      const input = boundedText(text, inputBytes);
      if (signal && aborted.call(signal)) return Promise.reject(new AgentHostError("E_ADK_HOST_TURN_CANCELLED"));
      const controller = new AbortController();
      let reject!: (error: AgentHostError) => void;
      const stopped = new Promise<never>((_, no) => { reject = no; });
      const op: Operation = {
        controller, request: Object.freeze({ _turn_id: `host-turn-${randomUUID()}`, _source: "synthetic-local" as const,
          _text: input, _signal: controller.signal }),
        deadline: performance.now() + timeout, invoked: false, replied: false, authorized: false,
        stop(code) { if (!op.error) { op.error = new AgentHostError(code); controller.abort(); reject(op.error); } },
      };
      active = op;
      const cancel = () => op.stop("E_ADK_HOST_TURN_CANCELLED");
      if (signal) addAbort.call(signal, "abort", cancel, { once: true });
      const timer = setTimeout(() => op.stop("E_ADK_HOST_TURN_TIMEOUT"), timeout);
      const actual = Promise.resolve().then(() => { check(op); return invoke(); });
      op.actual = actual;
      const release = () => {
        clearTimeout(timer); if (signal) removeAbort.call(signal, "abort", cancel);
        if (op.context) contexts.delete(op.context);
        if (active === op) active = undefined;
        op.result = undefined;
      };
      void actual.then(release, release);
      // Caller fencing does not release admission or claim the actual work stopped.
      return Promise.race([actual, stopped]);
    },
  });
}
