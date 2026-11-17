import { createHash } from "node:crypto";

/** JSON array serialization keeps key segments ordered and unambiguous. */
export function canonicalKey(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

/** Stable UUID-shaped XDB identity used to make partial-write retries idempotent. */
export function deterministicId(namespace: string, key: string): string {
  const hex = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(key)
    .digest("hex")
    .slice(0, 32)
    .split("");

  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** Stable lexicographic history cursor: UTC occurrence time followed by record identity. */
export function messageHistoryKey(
  occurredAt: Date | string,
  messageId: string,
): string {
  const date = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Message history key requires a valid occurrence time");
  }
  if (typeof messageId !== "string" || messageId.length === 0) {
    throw new Error("Message history key requires a message identity");
  }
  return canonicalKey([date.toISOString(), messageId]);
}
