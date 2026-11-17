import { createRouterAgent, routerTextModel, type RouterAgent, type RouterTextModel, type DurableAgentOptions } from "@xpell/agent/adk";
declare const base: DurableAgentOptions;
const model: RouterTextModel = routerTextModel({ _endpoint: "http://127.0.0.1:18451", _model: "fixture-chat",
  _credential: { _env: "DISPOSABLE_KEY" }, _timeout_ms: 5000, _error_policy: "fail-closed", _allow_requests: true });
const app: RouterAgent = createRouterAgent({ ...base, _model: model });
const reply: Promise<string> = app.chat({ _text: "hello", _external_message_id: "stable" });
void reply;
// @ts-expect-error Router mode exposes local chat, not the mock fixture method.
app.testTurn({ _text: "hello" });
// @ts-expect-error Credentials are references, never raw key values.
routerTextModel({ _endpoint: "http://127.0.0.1:18451", _model: "fixture-chat", _credential: { _value: "secret" }, _timeout_ms: 5000, _error_policy: "fail-closed", _allow_requests: true });
