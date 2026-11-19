import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockChannel, mockTextModel } from "@xpell/agent/adk";
import { createAgentHost } from "@xpell/agent/adk/host";

// Experimental, source-built artifact only. No environment/credential loading.
const args = process.argv.slice(2);
if (args.length !== 0 && args.length !== 2) throw Error("Expected optional canonical resource directory and reviewed SHA256");
const parent = await realpath(await mkdtemp(join(tmpdir(), "xagent-host-example-")));
let host;
try {
  host = createAgentHost({
    _profile: { _type: "foundation", _options: {
      _name: "reference-host", _model: mockTextModel({ _text: "Hello from the mock" }),
      _channel: mockChannel({ _id: "local" }), _plugins: [],
      _host: { _work_folder: join(parent, "runtime"), _listen: { _host: "127.0.0.1", _port: 0 } },
    } },
    _system_apps: args.length ? [{ _env: "default", _app_id: "sample-host", _source_dir: args[0], _sha256: args[1] }] : [],
  });
  await host.start();
  console.log(await host.testTurn({ _text: "hello" }));
} finally {
  try { await host?.close(); }
  finally { await rm(parent, { recursive: true, force: true }); }
}
