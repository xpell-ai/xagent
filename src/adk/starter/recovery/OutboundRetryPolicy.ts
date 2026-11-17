import type { MessageRecord } from "../persistence/types.js";

export type OutboundRecoveryPolicy = Readonly<{
  _max_attempts: number;
  _base_delay_ms: number;
  _max_delay_ms: number;
  _rate_limit_floor_ms: number;
  _max_per_start: number;
  _scan_limit: number;
  _send_timeout_ms: number;
}>;

export const DEFAULT_OUTBOUND_RECOVERY_POLICY: OutboundRecoveryPolicy = Object.freeze({
  _max_attempts: 3,
  _base_delay_ms: 30_000,
  _max_delay_ms: 3_600_000,
  _rate_limit_floor_ms: 60_000,
  _max_per_start: 10,
  _scan_limit: 100,
  _send_timeout_ms: 10_000,
});

const RETRYABLE = "E_STARTER_RECOVERY_RETRYABLE";
const RATE_LIMITED = "E_STARTER_RECOVERY_RATE_LIMITED";
export const TERMINAL_FAILURE = "E_STARTER_RECOVERY_TERMINAL";
const MAX_PROVIDER_DELAY_MS = 604_800_000;

export function recoveryPolicy(overrides: Partial<OutboundRecoveryPolicy> = {}): OutboundRecoveryPolicy {
  const policy = { ...DEFAULT_OUTBOUND_RECOVERY_POLICY, ...overrides };
  const bounds: Record<keyof OutboundRecoveryPolicy, [number, number]> = {
    _max_attempts: [1, 10], _base_delay_ms: [1_000, 86_400_000],
    _max_delay_ms: [1_000, MAX_PROVIDER_DELAY_MS],
    _rate_limit_floor_ms: [1_000, MAX_PROVIDER_DELAY_MS],
    _max_per_start: [1, 100], _scan_limit: [1, 1_000],
    _send_timeout_ms: [1, 60_000],
  };
  for (const [key, [min, max]] of Object.entries(bounds) as Array<[keyof OutboundRecoveryPolicy, [number, number]]>) {
    const value = policy[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`Invalid outbound recovery policy: ${key}`);
    }
  }
  if (policy._max_delay_ms < policy._base_delay_ms) {
    throw new Error("Invalid outbound recovery delay range");
  }
  return Object.freeze(policy);
}

export function safeFailureCode(input: {
  _category?: "rejected" | "rate_limited" | "unknown";
  _permanent?: boolean;
  _retry_after_ms?: number;
  _attempt_count: number;
}, policy: OutboundRecoveryPolicy): string {
  if (input._category !== "rejected" && input._category !== "rate_limited") {
    return TERMINAL_FAILURE;
  }
  if (input._permanent === true || input._attempt_count >= policy._max_attempts ||
      (input._retry_after_ms !== undefined &&
        (!Number.isSafeInteger(input._retry_after_ms) ||
          input._retry_after_ms < 0 || input._retry_after_ms > MAX_PROVIDER_DELAY_MS))) {
    return TERMINAL_FAILURE;
  }
  if (input._category === "rate_limited") {
    return `${RATE_LIMITED}:${input._attempt_count}:${input._retry_after_ms ?? 0}`;
  }
  return `${RETRYABLE}:${input._attempt_count}`;
}

export function retryDueAt(record: MessageRecord, policy: OutboundRecoveryPolicy): number | null {
  const attempts = record._attempt_count;
  if (record._delivery_state !== "failed" || !Number.isSafeInteger(attempts) ||
      attempts! < 1 || attempts! >= policy._max_attempts ||
      (record._last_error_category !== "rejected" && record._last_error_category !== "rate_limited")) {
    return null;
  }
  const timestamp = record._last_error_at instanceof Date
    ? record._last_error_at.valueOf() : Date.parse(record._last_error_at ?? "");
  if (!Number.isFinite(timestamp)) return null;
  let providerDelay = 0;
  if (record._last_error_category === "rejected") {
    if (record._failure_code !== `${RETRYABLE}:${attempts}`) return null;
  } else {
    const match = /^E_STARTER_RECOVERY_RATE_LIMITED:(?:[1-9]\d*):(0|[1-9]\d*)$/u.exec(record._failure_code ?? "");
    if (!match) return null;
    if (record._failure_code !== `${RATE_LIMITED}:${attempts}:${match[1]}`) return null;
    providerDelay = Number(match[1]);
    if (!Number.isSafeInteger(providerDelay) || providerDelay > MAX_PROVIDER_DELAY_MS) return null;
  }
  const backoff = Math.min(policy._max_delay_ms, policy._base_delay_ms * 2 ** (attempts! - 1));
  return timestamp + Math.max(backoff,
    record._last_error_category === "rate_limited" ? policy._rate_limit_floor_ms : 0,
    providerDelay);
}
