import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, mockChannel, mockTextModel } from "@xpell/agent/adk";

// Explicitly disposable runtime files and an ephemeral loopback HTTP listener.
const parent = await mkdtemp(join(tmpdir(), "xagent-hello-"));
const app = createAgent({
  _name: "hello-agent",
  _model: mockTextModel({ _text: "Hello from the mock" }),
  _channel: mockChannel({ _id: "local" }),
  _host: { _work_folder: join(parent, "runtime"),
    _listen: { _host: "127.0.0.1", _port: 0 } },
  _plugins: [],
});
try {
  await app.start();
  console.log(await app.testTurn({ _text: "hello" }));
} finally {
  try { await app.close(); }
  finally { await rm(parent, { recursive: true, force: true }); }
}
