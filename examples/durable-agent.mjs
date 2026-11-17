import { resolve } from "node:path";
import { createDurableAgent, mockChannel, mockTextModel } from "@xpell/agent/adk";

if (!process.argv[2]) throw new Error("Supply a new synthetic instance path in an existing operator-owned parent; run twice in fresh processes.");
const app = createDurableAgent({
  _name: "durable-example", _model: mockTextModel({ _text: "Saved local reply" }),
  _channel: mockChannel({ _id: "local" }),
  _host: { _work_folder: resolve(process.argv[2]), _listen: { _host: "127.0.0.1", _port: 0 } },
  _conversations: { _provider: "sqlite", _instance_id: "durable-example",
    _application_scope: { _env: "development", _app_id: "example" }, _history_limit: 20,
    _context: { _max_context_tokens: 2048, _reserved_output_tokens: 256,
      _safety_margin_tokens: 128, _system_instructions: "Respond to local synthetic fixtures." } },
});
try {
  await app.start();
  console.log(await app.testTurn({ _text: "A synthetic message", _external_message_id: "example-delivery" }));
  console.log(JSON.stringify(await app.getHistory()));
  console.log(JSON.stringify(await app.getContext({ _current_text: "Preview recovered context" })));
} finally { await app.close(); }
