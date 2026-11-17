import { XAgent } from "@xpell/agent";
import { createAgent, mockChannel, mockTextModel, type AgentFoundation } from "@xpell/agent/adk";

new XAgent({ _name: "legacy-agent" });
const app: AgentFoundation = createAgent({
  _name: "hello-agent", _model: mockTextModel({ _text: "hello" }),
  _channel: mockChannel({ _id: "local" }), _plugins: [],
  _host: { _work_folder: "/tmp/operator-provided-new-runtime",
    _listen: { _host: "127.0.0.1", _port: 0 } },
});
const reply: Promise<string> = app.testTurn({ _text: "hello" });
void reply;
