import { AgentAdkError, composeFoundation, type AgentFoundation, type AgentFoundationOptions,
  type AgentFoundationStatus } from "./foundation.js";
import { absolute, AgentHostError, data, descriptor, fail, list, resourcePort,
  type HostSystemAppSource, type HostResourceState, type AgentHostErrorCode } from "./host/resources.js";
export { AgentHostError, type AgentHostErrorCode, type HostSystemAppSource } from "./host/resources.js";

/** @experimental P2.2 only. Profile nesting and integrity descriptors may change before publication. */
export type AgentHostOptions = Readonly<{
  _profile: Readonly<{ _type: "foundation"; _options: AgentFoundationOptions }>;
  _system_apps?: readonly HostSystemAppSource[];
}>;
/** @experimental Safe state only; no raw host/store or independently closable inner Agent. */
export type AgentHostStatus = Readonly<{
  _state: AgentFoundationStatus["_state"]; _profile: "foundation";
  _agent: AgentFoundationStatus; _resources: HostResourceState; _error_code?: AgentHostErrorCode;
}>;
/** @experimental P2.2 only; no permanent public contract is implied. */
export type AgentHost = Readonly<Pick<AgentFoundation, "start" | "close" | "testTurn"> & { getStatus(): AgentHostStatus }>;

function foundation(value: unknown): AgentFoundationOptions {
  const o = data(value, ["_name", "_model", "_channel", "_host", "_plugins"]);
  const model = data(o._model, ["_type", "_text"]), channel = data(o._channel, ["_type", "_id"]);
  const host = data(o._host, ["_work_folder", "_listen"]), listen = data(host._listen, ["_host", "_port"]);
  if (o._plugins !== undefined) list(o._plugins, 0);
  // composeFoundation validates scalar/model/channel values against its unchanged contract.
  return { _name: o._name as string, _model: Object.freeze(model) as AgentFoundationOptions["_model"],
    _channel: Object.freeze(channel) as AgentFoundationOptions["_channel"], _plugins: [],
    _host: { _work_folder: absolute(host._work_folder), _listen: Object.freeze(listen) as AgentFoundationOptions["_host"]["_listen"] } };
}
function safe(error: unknown, fallback: AgentHostErrorCode): AgentHostError {
  if (error instanceof AgentHostError) return error;
  if (error instanceof AgentAdkError && error._code === "E_ADK_CLEANUP") return new AgentHostError("E_ADK_HOST_CLEANUP");
  if (error instanceof AgentAdkError && ["E_ADK_HOST_IN_USE", "E_ADK_CLOSED", "E_ADK_NOT_READY", "E_ADK_CONFIG"].includes(error._code))
    return new AgentHostError(error._code as AgentHostErrorCode);
  return new AgentHostError(fallback);
}
/** @experimental Opt-in fresh mock host and zero/one view-only native XVM resource. */
export function createAgentHost(options: AgentHostOptions): AgentHost {
  const o = data(options, ["_profile", "_system_apps"]), profile = data(o._profile, ["_type", "_options"]);
  if (profile._type !== "foundation") return fail("E_ADK_HOST_CONFIG");
  const config = foundation(profile._options), sources = list(o._system_apps ?? [], 1).map(descriptor);
  const resources = resourcePort(config._host._work_folder, sources[0]);
  let base: AgentFoundation;
  try { base = composeFoundation(config, undefined, resources); } catch (e) { throw safe(e, "E_ADK_HOST_CONFIG"); }
  let startup: Promise<void> | undefined, closing: Promise<void> | undefined, error: AgentHostError | undefined;
  return Object.freeze({
    start() {
      if (["closing", "closed"].includes(base.getStatus()._state)) return Promise.reject(new AgentHostError("E_ADK_CLOSED"));
      return startup ??= base.start().catch(e => { error = safe(e, "E_ADK_HOST_START"); throw error; });
    },
    close() { return closing ??= base.close().catch(e => { error = safe(e, "E_ADK_HOST_CLEANUP"); throw error; }); },
    async testTurn(input) {
      const v = data(input, ["_text"]);
      try { return await base.testTurn({ _text: v._text as string }); } catch (e) { throw safe(e, "E_ADK_CONFIG"); }
    },
    getStatus() {
      const agent = base.getStatus();
      return Object.freeze({ _state: agent._state, _profile: "foundation" as const, _agent: agent,
        _resources: resources.state(), ...(error ? { _error_code: error._code } : {}) });
    },
  });
}
