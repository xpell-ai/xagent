import {
  createAgent, mockChannel, mockTextModel, type AgentFoundation,
} from "@xpell/agent/adk";

/** Supply a new disposable directory; the installed ADK owns the runtime. */
export function defineReferenceAgent(workFolder: string): AgentFoundation {
  return createAgent({
    _name: "reference-agent",
    _model: mockTextModel({ _text: "Hello from the reference agent" }),
    _channel: mockChannel({ _id: "local" }),
    _host: {
      _work_folder: workFolder,
      _listen: { _host: "127.0.0.1", _port: 0 },
    },
    _plugins: [],
  });
}
