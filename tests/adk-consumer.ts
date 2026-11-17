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

import { createDurableAgent, type DurableAgent, type ConversationHistory } from "@xpell/agent/adk";
const durable: DurableAgent = createDurableAgent({
  _name: "durable-agent", _model: mockTextModel({ _text: "hello" }),
  _channel: mockChannel({ _id: "local" }),
  _host: { _work_folder: "/tmp/operator-provided-synthetic-instance", _listen: { _host: "127.0.0.1", _port: 0 } },
  _conversations: { _provider: "sqlite", _instance_id: "fixture", _application_scope: { _env: "test", _app_id: "app" },
    _history_limit: 20, _context: { _max_context_tokens: 512, _reserved_output_tokens: 64, _safety_margin_tokens: 32, _system_instructions: "fixture" } },
});
const history: Promise<ConversationHistory> = durable.getHistory();
const context: Promise<{ _messages: readonly unknown[] }> = durable.getContext({ _current_text: "preview" });
void durable.testTurn({ _text: "hello", _external_message_id: "stable", _external_conversation_id: "conv" });
void history; void context;
// @ts-expect-error Durable profile requires explicit storage/scope/budget.
createDurableAgent({ _name: "missing-profile", _model: mockTextModel({ _text: "hello" }), _channel: mockChannel({ _id: "local" }), _host: { _work_folder: "/tmp/new", _listen: { _host: "127.0.0.1", _port: 0 } } });
