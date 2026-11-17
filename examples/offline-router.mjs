import http from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Contract fixture only: no accounts, provider SDKs, credits or billing engine.
export const OFFLINE_ROUTER_KEY = "offline-fixture-key";
export async function startOfflineRouter({ _port = 0, _mode = "success" } = {}) {
  let mode = _mode;
  const requests = [], results = new Map(), timers = new Set();
  let generations = 0;
  const server = http.createServer(async (req, res) => {
    const send = (request, value, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ _v: 2, _id: "fixture-response", _kind: "RES", _rid: request?._id,
        _payload: value }));
    };
    try {
      if (req.method !== "POST" || req.url !== "/wh/v2/call") { res.writeHead(404).end(); return; }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 262144) throw Error("size"); chunks.push(chunk); }
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ request, headers: req.headers });
      const p = request._payload?._params;
      if (request._v !== 2 || request._kind !== "REQ" || typeof request._id !== "string" ||
          request._payload?._module !== "xai-router" || request._payload?._op !== "generate") {
        send(request, { _ok: false, _error: { _code: "E_FIXTURE_PROTOCOL" } }, 400); return;
      }
      if (p?._api_key !== OFFLINE_ROUTER_KEY) {
        send(request, { _ok: true, _result: { _ok: false, _error: { _code: p?._api_key ? "E_XAI_API_KEY_INVALID" : "E_XAI_API_KEY_REQUIRED",
          _message: "RAW_PROVIDER_SECRET_DO_NOT_LEAK", _details: { _message: OFFLINE_ROUTER_KEY } } } }); return;
      }
      if (mode === "timeout") {
        const timer = setTimeout(() => { timers.delete(timer); res.writeHead(504).end(); }, 1000); timers.add(timer); return;
      }
      if (mode === "non-json") { res.writeHead(502, { "content-type": "text/html" }).end("RAW_PROVIDER_SECRET_DO_NOT_LEAK"); return; }
      if (mode === "malformed") { res.writeHead(200, { "content-type": "application/json" }).end("{bad RAW_PROVIDER_SECRET_DO_NOT_LEAK"); return; }
      if (["routing-error", "metering-error"].includes(mode)) {
        const code = mode === "routing-error" ? "E_XAI_REQUESTED_MODEL_NOT_ALLOWED" : "E_XAI_METERING_INCOMPLETE";
        send(request, { _ok: true, _result: { _ok: false, _error: { _code: code, _message: "RAW_PROVIDER_SECRET_DO_NOT_LEAK" } } }); return;
      }
      if (mode === "missing-result") { send(request, { _ok: true, _result: {} }); return; }
      const key = p._idempotency_key;
      const user = p._messages?.at(-1)?._content?.[0]?._text;
      if (typeof key !== "string" || typeof user !== "string") { send(request, { _ok: false, _error: { _code: "E_FIXTURE_CONTRACT" } }, 400); return; }
      let result = results.get(key);
      if (!result) {
        generations++;
        result = { _ok: true, _text: mode === "planning" ? "<think>fixture internal planning" : `Offline Router: ${user}`,
          _model: p._model, _provider: "fixture", _finish_reason: mode === "truncated" ? "length" : "stop",
          _usage: { _input_tokens: 2, _output_tokens: 3, _total_tokens: 5 },
          ...(mode === "tools" ? { _tool_calls: [{ _id: "fixture-tool", _name: "unapproved", _arguments: {} }] } : {}) };
        results.set(key, result);
      }
      send(request, { _ok: true, _result: result });
    } catch { if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ _ok: false })); }
  });
  await new Promise((ok, fail) => { server.once("error", fail); server.listen({ host: "127.0.0.1", port: _port }, ok); });
  return { endpoint: `http://127.0.0.1:${server.address().port}`, requests,
    setMode(value) { mode = value; }, get generations() { return generations; },
    async close() { for (const t of timers) clearTimeout(t); server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw Error("Supply an explicit loopback fixture port (0 for ephemeral)");
  const fixture = await startOfflineRouter({ _port: port });
  console.log("OFFLINE_ROUTER_READY", fixture.endpoint);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await fixture.close(); process.exit(0); });
}
