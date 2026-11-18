import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineReferenceAgent } from "./agent.js";

const parent = await mkdtemp(join(tmpdir(), "xagent-reference-"));
const app = defineReferenceAgent(join(parent, "runtime"));
try {
  await app.start();
  console.log(await app.testTurn({ _text: "hello" }));
} finally {
  try { await app.close(); }
  finally { await rm(parent, { recursive: true, force: true }); }
}
