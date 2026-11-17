import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createRouterAgent, routerTextModel, mockChannel, AgentAdkError } from "@xpell/agent/adk";
import { startOfflineRouter, OFFLINE_ROUTER_KEY } from "./offline-router.mjs";

// Default demonstration owns its offline fixture. Any supplied Router config
// requires an explicit operator approval assertion, separate from this demo.
const [mode, target, id, text, ...extra] = process.argv.slice(2);
if (!["--offline", "--approved-router"].includes(mode) || !target || !id || !text || extra.length) {
  throw Error("Usage: router-chat.mjs --offline NEW_INSTANCE_PATH MESSAGE_ID TEXT | --approved-router APPROVED_CONFIG_JSON MESSAGE_ID TEXT");
}
let fixture, app;
try {
  let config;
  if (mode === "--offline") {
    fixture = await startOfflineRouter({ _port: 0 });
    process.env.XAGENT_OFFLINE_FIXTURE_KEY = OFFLINE_ROUTER_KEY;
    config = { _name: "router-chat", _model: routerTextModel({ _endpoint: fixture.endpoint,
      _model: "fixture-chat", _credential: { _env: "XAGENT_OFFLINE_FIXTURE_KEY" },
      _timeout_ms: 5000, _error_policy: "fail-closed", _allow_requests: true }),
      _channel: mockChannel({ _id: "local" }),
      _host: { _work_folder: resolve(target), _listen: { _host: "127.0.0.1", _port: 0 } },
      _conversations: { _provider: "sqlite", _instance_id: "router-chat-example",
        _application_scope: { _env: "development", _app_id: "router-chat-example" }, _history_limit: 20,
        _context: { _max_context_tokens: 2048, _reserved_output_tokens: 256, _safety_margin_tokens: 128,
          _system_instructions: "Respond to local synthetic fixtures." } } };
  } else {
    if (process.env.XAGENT_OWNER_APPROVED_ROUTER_CALLS !== "yes") throw new AgentAdkError("E_ADK_ROUTER_OWNER_APPROVAL_REQUIRED", "Separate owner approval is required");
    config = JSON.parse(await readFile(resolve(target), "utf8"));
  }
  app = createRouterAgent(config);
  await app.start();
  console.log(await app.chat({ _text: text, _external_message_id: id }));
  console.log(JSON.stringify(await app.getHistory()));
} catch (error) {
  // Never print provider causes, credentials, arbitrary messages or responses.
  const code = typeof error?._code === "string" && /^E_[A-Z0-9_]{1,80}$/.test(error._code) ? error._code : "E_ADK_ROUTER_CLI";
  console.error(JSON.stringify({ _ok: false, _error: { _code: code } })); process.exitCode = 1;
} finally {
  try { await app?.close(); }
  finally { await fixture?.close(); delete process.env.XAGENT_OFFLINE_FIXTURE_KEY; }
}
