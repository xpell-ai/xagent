import http from "node:http";
import { mkdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, createToolRegistry } from "@xpell/agent/adk/tools";
import { createDurableActions } from "@xpell/agent/adk/actions";
import { routerTextModel } from "@xpell/agent/adk";
import { createRouterToolLoop } from "@xpell/agent/adk/tool-loop";

// Synthetic Wormholes contract fixture, never a Router/provider implementation.
export const TOOL_LOOP_FIXTURE_KEY = "synthetic-tool-loop-fixture";
export const echoSchema = Object.freeze({ type: "object", additionalProperties: false,
  properties: { text: { type: "string", minLength: 1, maxLength: 64 } }, required: ["text"] });
export async function startToolLoopFixture(responses = [
  { _ok: true, _text: "", _finish_reason: "tool_calls", _tool_calls: [{ _id: "echo-1", _name: "sample.echo", _arguments: { text: "hello" }, _continuation_ref: "opaque-fixture-reference" }] },
  { _ok: true, _text: "Offline tool loop complete", _finish_reason: "stop" },
]) {
  const requests = [], timers = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/wh/v2/call") throw Error("fixture protocol");
      const chunks = []; let bytes = 0;
      for await (const c of req) { bytes += c.length; if (bytes > 65536) throw Error("fixture bound"); chunks.push(c); }
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const p = request._payload?._params;
      if (request._v !== 2 || request._kind !== "REQ" || request._payload?._module !== "xai-router" ||
          request._payload?._op !== "generate" || p?._api_key !== TOOL_LOOP_FIXTURE_KEY || !p._idempotency_key) throw Error("fixture envelope");
      requests.push(request);
      const { _delay_ms = 0, ...result } = responses[Math.min(requests.length - 1, responses.length - 1)];
      const send = () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ _v: 2, _kind: "RES", _id: "fixture", _rid: request._id, _payload: { _ok: true, _result: result } })); };
      if (_delay_ms) { const t = setTimeout(() => { timers.delete(t); send(); }, _delay_ms); timers.add(t); } else send();
    } catch { res.writeHead(400).end(); }
  });
  await new Promise((yes, no) => { server.once("error", no); server.listen({ host: "127.0.0.1", port: 0 }, yes); });
  return { endpoint: `http://127.0.0.1:${server.address().port}`, requests,
    async close() { for (const t of timers) clearTimeout(t); server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parent = process.argv[2]; if (!parent || !parent.startsWith("/")) throw Error("Supply an owned absolute disposable parent directory");
  await mkdir(parent, { recursive: true });
  const fixture = await startToolLoopFixture(); process.env.XAGENT_LOOP_FIXTURE = TOOL_LOOP_FIXTURE_KEY;
  const host = createDurableActions({ _name: "tool-loop-example", _instance_id: "example",
    _application_scope: { _env: "test", _app_id: "neutral-loop" },
    _host: { _work_folder: join(parent, "instance"), _listen: { _host: "127.0.0.1", _port: 0 } }, _actions: [],
    _limits: { _timeout_ms: 1000, _max_json_bytes: 4096 } });
  const reads = createToolRegistry({ _tools: [defineTool({ _id: "sample.echo", _description: "Echo synthetic text", _input_schema: echoSchema,
    _effect: "read", _confirmation: "none", _handler: ({ _arguments }) => ({ text: _arguments.text }) })],
    _policy: ({ _context }) => ({ _allow: true, _policy_revision: "fixture-1", _authorized_scope: _context }),
    _limits: { _timeout_ms: 1000, _max_input_bytes: 4096, _max_output_bytes: 8192, _max_invocations: 16, _max_contexts: 16 } });
  const loop = createRouterToolLoop({ _actions: host, _reads: reads, _action_ids: [], _system: "Synthetic offline tool loop.",
    _policy: () => true, _model: routerTextModel({ _endpoint: fixture.endpoint, _model: "fixture", _credential: { _env: "XAGENT_LOOP_FIXTURE" },
      _timeout_ms: 1000, _error_policy: "fail-closed", _allow_requests: true }),
    _limits: { _max_rounds: 3, _max_calls: 4, _max_calls_per_round: 4, _max_transcript_bytes: 8192,
      _max_output_tokens: 64, _max_total_tokens: 16384, _timeout_ms: 3000 } });
  try {
    await host.start(); await loop.start();
    const context = loop.bindContext({ _actor_id: "fixture-actor", _conversation_id: "fixture-conversation", _delivery_id: "fixture-delivery" });
    const first = await loop.run({ _text: "Echo hello" }, context);
    const replay = await loop.run({ _text: "Echo hello" }, context);
    if (first._status !== "completed" || !isDeepStrictEqual(first, replay) || fixture.requests.length !== 2) throw Error("Fixture qualification failed");
    console.log("MODEL_TOOL_LOOP_OFFLINE_PASS", first._status, fixture.requests.length);
  } finally { await loop.close(); reads.close(); await host.close(); await fixture.close(); delete process.env.XAGENT_LOOP_FIXTURE; }
}
