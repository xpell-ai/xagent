import { mockChannel, mockTextModel } from "@xpell/agent/adk";
import { createAgentHost, type AgentHost, type AgentHostStatus, type HostSystemAppSource } from "@xpell/agent/adk/host";

const sources: readonly HostSystemAppSource[] = [];
const host: AgentHost = createAgentHost({
  _profile: { _type: "foundation", _options: {
    _name: "neutral-host", _model: mockTextModel({ _text: "Hello" }),
    _channel: mockChannel({ _id: "local" }), _plugins: [],
    _host: { _work_folder: "/operator-owned/new-instance", _listen: { _host: "127.0.0.1", _port: 0 } },
  } }, _system_apps: sources,
});
const status: AgentHostStatus = host.getStatus();
const reply: Promise<string> = host.testTurn({ _text: "hello" });
void status; void reply;
// @ts-expect-error P2.2 does not accept durable profiles or host adoption.
createAgentHost({ _profile: { _type: "actions", _options: {} } });
// @ts-expect-error Host does not grant raw engine access.
host.node.start();
