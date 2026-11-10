export class FakeChannel {
  constructor({
    id = "fake-channel",
    provider = "fake",
    failStart = false,
    failSend = false,
    startGate,
  } = {}) {
    this._id = id;
    this._provider = provider;
    this.failStart = failStart;
    this.failSend = failSend;
    this.startGate = startGate;
    this.outbound = [];
    this.lifecycle = ["registered"];
    this.startCount = 0;
    this.stopCount = 0;
    this.runtime = undefined;
    this.status = "registered";
    this.error = undefined;
    this.sequence = 0;
    this.startPromise = undefined;
  }

  async start(runtime) {
    if (this.status === "ready") return;
    if (this.startPromise !== undefined) return this.startPromise;

    this.startCount += 1;
    this.runtime = runtime;
    this.status = "starting";
    this.lifecycle.push("starting");

    this.startPromise = (async () => {
      if (this.startGate !== undefined) await this.startGate;
      if (this.failStart) {
        this.status = "not_ready";
        this.error = {
          _code: "E_FAKE_START",
          _message: "Fake Channel failed to start",
        };
        this.lifecycle.push("not_ready");
        throw new Error("fake-provider-secret-start-failure");
      }
      this.status = "ready";
      this.lifecycle.push("ready");
    })();

    return this.startPromise;
  }

  async stop() {
    if (this.status === "stopped") return;
    this.stopCount += 1;
    this.status = "stopped";
    this.error = undefined;
    this.lifecycle.push("stopped");
  }

  getStatus() {
    return {
      _id: this._id,
      _provider: this._provider,
      _status: this.status,
      _ready: this.status === "ready",
      ...(this.error === undefined ? {} : { _error: { ...this.error } }),
    };
  }

  async send(message) {
    if (this.failSend) {
      throw new Error("fake-provider-secret-send-failure");
    }
    if (this.status !== "ready") {
      throw new Error("Fake Channel is not ready");
    }

    this.sequence += 1;
    this.outbound.push({ ...message });
    return {
      _accepted: true,
      _external_message_id: `${this._id}-out-${this.sequence}`,
      _accepted_at: 1_700_000_000_000 + this.sequence,
    };
  }

  async inject(message) {
    if (this.runtime === undefined) {
      throw new Error("Fake Channel has not started");
    }
    return this.runtime.receive(message);
  }
}
