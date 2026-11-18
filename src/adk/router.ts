import { createHash, randomUUID } from "node:crypto";
import { _x, _xai, type XAIProvider } from "@xpell/node";
import type { AimeProvider } from "@xpell/xai-providers/aime";
import { AgentAdkError, mockTextModel, record, text } from "./foundation.js";
import { composeDurableAgent, type ConversationModel, type DurableAgent,
  type DurableAgentOptions, type DurableTurnInput } from "./conversations.js";
import { hasPlanningEnvelope } from "./starter/conversation/UserVisibleReply.js";

export type RouterTextModel = Readonly<{
  _type: "xai-router";
  /** Origin only: loopback HTTP or HTTPS; no path, userinfo, query or fragment. */
  _endpoint: string;
  _model: string;
  /** Environment variable name; the secret is read only at start, never stored in settings. */
  _credential: Readonly<{ _env: string }>;
  _timeout_ms: number;
  _error_policy: "fail-closed";
  /** Explicit consent to requests when chat() is called. start() never probes. */
  _allow_requests: true;
}>;
export type RouterAgentOptions = Omit<DurableAgentOptions, "_model"> & { _model: RouterTextModel };
export type RouterAgent = Omit<DurableAgent, "testTurn"> & Readonly<{
  /** Local programmatic ingress, synthetic identity; no public chat HTTP API. */
  chat(input: DurableTurnInput): Promise<string>;
}>;

function fail(code: string): AgentAdkError { return new AgentAdkError(code, "Router chat failed; see the runbook for this safe error code"); }

/** Pure configuration. No provider import, credential read, registration or request. */
export function routerTextModel(input: Omit<RouterTextModel, "_type">): RouterTextModel {
  const v = record(input, ["_endpoint", "_model", "_credential", "_timeout_ms", "_error_policy", "_allow_requests"]);
  const credential = record(v._credential, ["_env"]);
  const env = text(credential._env);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env) || !Number.isSafeInteger(v._timeout_ms) ||
      Number(v._timeout_ms) < 1 || Number(v._timeout_ms) > 120000 || v._error_policy !== "fail-closed" || v._allow_requests !== true) {
    throw fail("E_ADK_ROUTER_CONFIG");
  }
  let endpoint: URL;
  try { endpoint = new URL(text(v._endpoint)); } catch { throw fail("E_ADK_ROUTER_CONFIG"); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/" ||
      !(endpoint.protocol === "https:" || endpoint.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(endpoint.hostname))) {
    throw fail("E_ADK_ROUTER_CONFIG");
  }
  return Object.freeze({ _type: "xai-router", _endpoint: endpoint.origin, _model: text(v._model),
    _credential: Object.freeze({ _env: env }), _timeout_ms: v._timeout_ms as number,
    _error_policy: "fail-closed", _allow_requests: true });
}

// Only reviewed codes cross the boundary; never forward provider messages,
// details, raw responses, credentials, usage ledger or arbitrary error causes.
const ROUTER_CODES = new Set([
  "E_XAI_API_KEY_REQUIRED", "E_XAI_API_KEY_INVALID", "E_XAI_INSUFFICIENT_CREDITS",
  "E_XAI_METERING_INCOMPLETE", "E_XAI_REQUESTED_MODEL_NOT_ALLOWED", "E_XAI_REQUESTED_PROVIDER_NOT_ALLOWED",
  "E_XAI_MODEL_PROFILE_REQUIRED", "E_XAI_PROVIDER_GENERATE_FAILED", "E_XAI_RATE_LIMIT_EXCEEDED",
  "E_XAI_DAILY_REQUEST_LIMIT_EXCEEDED", "E_XAI_DAILY_TOKEN_LIMIT_EXCEEDED",
]);
function safeFailure(error: unknown): AgentAdkError {
  if (error instanceof AgentAdkError) return error;
  if ((error as { name?: unknown })?.name === "AbortError") return fail("E_ADK_ROUTER_TIMEOUT");
  const code = (error as { _code?: unknown })?._code;
  return fail(typeof code === "string" && ROUTER_CODES.has(code) ? code : "E_ADK_ROUTER_TRANSPORT");
}

/** Internal shared XAI/AimeProvider connection; no additional host or transport. */
export class RouterModel implements ConversationModel {
  readonly #id = `adk-router-${randomUUID()}`;
  #provider?: AimeProvider;
  #closed = false;
  #registered = false;
  constructor(readonly config: RouterTextModel, readonly options: Pick<RouterAgentOptions, "_name"> & { _conversations: Pick<RouterAgentOptions["_conversations"], "_instance_id" | "_application_scope"> }) {}

  async prepare(): Promise<void> {
    if (this.#closed) throw fail("E_ADK_CLOSED");
    const secret = process.env[this.config._credential._env];
    if (!secret?.trim()) throw fail("E_ADK_ROUTER_CREDENTIAL");
    let Provider: typeof AimeProvider;
    try { ({ AimeProvider: Provider } = await import("@xpell/xai-providers/aime")); }
    catch { throw fail("E_ADK_ROUTER_DEPENDENCY"); }
    if (this.#closed) throw fail("E_ADK_CLOSED");
    this.#provider = new Provider({ endpoint: this.config._endpoint, apiKey: secret, timeoutMs: this.config._timeout_ms });
  }

  async start(): Promise<void> {
    if (this.#closed || !this.#provider || !_x.isRunning()) throw fail("E_ADK_CLOSED");
    const ids = await _xai._list_providers();
    if (ids._providers.includes(this.#id)) throw fail("E_ADK_ROUTER_PROVIDER_COLLISION");
    const provider: XAIProvider = {
      _provider_id: this.#id,
      generate: async (input) => {
        if (this.#closed || !this.#provider) throw fail("E_ADK_CLOSED");
        try { return await this.#provider.generate(input); }
        catch (error) { throw safeFailure(error); }
      },
    };
    _xai.registerProvider(this.#id, provider);
    this.#registered = true;
  }

  async generate(input: Parameters<ConversationModel["generate"]>[0]): Promise<string> {
    if (this.#closed || !this.#registered) throw fail("E_ADK_CLOSED");
    const scope = this.options._conversations._application_scope;
    const key = createHash("sha256").update(JSON.stringify(["adk-router-chat/1",
      this.options._conversations._instance_id, input._idempotency_key])).digest("hex");
    const c = input._context;
    const r = await this.round({ _messages: c._messages,
      _task: c._task, system: c._system, context: c._context, max_tokens: c._reserved_output_tokens,
      _app_id: scope._app_id, _env: scope._env, _caller_module: this.options._name,
      _caller_op: "receive-message", _purpose: "agent-chat", _idempotency_key: key,
      response_format: { type: "text" },
    });
    if (r._tool_calls?.length || typeof r._text !== "string" || !r._text.trim() || hasPlanningEnvelope(r._text) || r._finish_reason !== "stop") {
      throw fail("E_ADK_ROUTER_RESULT");
    }
    return r._text;
  }

  async round(params: Record<string, unknown>): Promise<Record<string, any>> {
    if (this.#closed || !this.#registered) throw fail("E_ADK_CLOSED");
    const response = await _x.execute({ _module: "xai", _op: "generate", _params: {
      ...params, _provider: this.#id, _model: this.config._model,
    } });
    const r = response?._result ?? response;
    if (response?._ok !== true || r?._ok !== true) {
      const code = r?._code ?? r?._error?._code;
      if (code === "E_ADK_ROUTER_TIMEOUT" || code === "E_ADK_ROUTER_TRANSPORT" || ROUTER_CODES.has(code)) throw fail(code);
      throw fail("E_ADK_ROUTER_GENERATE");
    }
    return r;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#provider?.setApiKey("");
    this.#provider = undefined;
    // XAI exposes no unregister. The owned registry entry remains inert in the
    // terminal host; it holds no provider/credential and cannot issue requests.
  }
}

export function createRouterAgent(options: RouterAgentOptions): RouterAgent {
  const v = record(options, ["_name", "_model", "_channel", "_host", "_plugins", "_conversations"]);
  const m = record(v._model, ["_type", "_endpoint", "_model", "_credential", "_timeout_ms", "_error_policy", "_allow_requests"]);
  if (m._type !== "xai-router") throw fail("E_ADK_ROUTER_CONFIG");
  const { _type: ignored, ...config } = m;
  const model = routerTextModel(config as Omit<RouterTextModel, "_type">);
  // Deep-snapshot validated data; no caller mutation can redirect an active host.
  const snapshot = structuredClone({ ...v, _model: model }) as RouterAgentOptions;
  const port = new RouterModel(model, snapshot);
  const base = composeDurableAgent({ ...snapshot, _model: mockTextModel({ _text: "unused Router placeholder" }) }, port);
  const { testTurn, ...api } = base;
  return Object.freeze({ ...api, chat: (input: DurableTurnInput) => testTurn(input) });
}
