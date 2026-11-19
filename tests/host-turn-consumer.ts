import { createAgentHost, type AgentHostOptions, type HostTurnDelegate, type HostTurnRequest } from "@xpell/agent/adk/host";
import { createAgent, mockChannel, mockTextModel } from "@xpell/agent/adk";
const delegate: HostTurnDelegate = {
  _authorize: ({ _phase, _signal }) => !_signal.aborted && ["run", "reply"].includes(_phase),
  _run: async (request: HostTurnRequest) => request._text,
  _limits: { _timeout_ms: 1000, _max_input_bytes: 512, _max_output_bytes: 1024 },
};
const profile = { _name: "typed-host", _model: mockTextModel({ _text: "mock" }), _channel: mockChannel({ _id: "local" }),
  _host: { _work_folder: "/disposable/new-instance", _listen: { _host: "127.0.0.1" as const, _port: 0 } }, _plugins: [] };
const options: AgentHostOptions = { _profile: { _type: "foundation", _options: profile }, _turn: delegate };
const host = createAgentHost(options);
const result: Promise<string> = host.testTurn({ _text: "synthetic" }, new AbortController().signal);
void result;
// @ts-expect-error Experimental Host option does not change public Foundation options.
createAgent({ ...profile, _turn: delegate });
// @ts-expect-error No raw host or independently closable inner Agent.
host.node.stop();
// @ts-expect-error Model/user payload cannot supply actor/scope authority.
host.testTurn({ _text: "synthetic", _actor_id: "admin" });
// @ts-expect-error A delegate must have explicit run/reply authorization.
createAgentHost({ ...options, _turn: { _run: delegate._run, _limits: delegate._limits } });
