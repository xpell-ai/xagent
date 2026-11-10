/** A provider-safe outcome classification. Unknown is the default for untyped errors. */
export type XChannelSendFailureCategory = "rejected" | "rate_limited" | "unknown";

export class XChannelSendFailure extends Error {
  readonly _send_failure_category: XChannelSendFailureCategory;
  readonly _retry_after_ms?: number;
  readonly _permanent: boolean;

  constructor(category: XChannelSendFailureCategory, message: string,
    options: Readonly<{ _retry_after_ms?: number; _permanent?: boolean }> = {}) {
    super(message);
    this.name = "XChannelSendFailure";
    this._send_failure_category = category;
    this._retry_after_ms = options._retry_after_ms;
    this._permanent = options._permanent === true;
  }
}
