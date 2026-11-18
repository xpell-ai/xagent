// Synthetic offline target only. The runbook declares better-sqlite3 explicitly.
import { resolve, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { defineAction, createDurableActions } from "@xpell/agent/adk/actions";

if (!process.argv[2]) throw Error("Provide a disposable parent directory");
const parent = resolve(process.argv[2]); await mkdir(parent, { recursive: true, mode: 0o700 });
const Database = createRequire(import.meta.url)("better-sqlite3");
const db = new Database(join(parent, "synthetic-target.sqlite"));
db.pragma("journal_mode = WAL"); db.pragma("synchronous = FULL");
db.exec("CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, receipt TEXT NOT NULL)");
const commit = db.transaction(input => {
  const receipt = { _action_id: input._action_id, _binding_hash: input._binding_hash, _idempotency_key: input._idempotency_key,
    _outcome: { _status: "succeeded", _result: { text: input._arguments.text } } };
  db.prepare("INSERT INTO receipts (id,receipt) VALUES (?,?)").run(input._idempotency_key, JSON.stringify(receipt));
  return receipt._outcome;
});
const record = defineAction({ _id: "sample.record", _description: "Write one synthetic local receipt", _revision: "1",
  _input_schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", minLength: 1, maxLength: 64 } }, required: ["text"] },
  _prepare_action: ({ _arguments }) => ({ _arguments, _authorized_scope: { target: "synthetic-local" }, _confirmation_summary: `Record ${_arguments.text}` }),
  _handler: input => commit(input),
  _read_committed_outcome: input => {
    const row = db.prepare("SELECT receipt FROM receipts WHERE id=?").get(input._idempotency_key);
    return row ? JSON.parse(row.receipt) : null;
  },
});
const actions = createDurableActions({ _name: "actions-example", _instance_id: "synthetic-example", _application_scope: { _env: "test", _app_id: "example" },
  _host: { _work_folder: join(parent, "action-profile"), _listen: { _host: "127.0.0.1", _port: 0 } },
  _actions: [record], _limits: { _timeout_ms: 1000, _max_json_bytes: 2048 },
  _policy: i => i._context._actor_id === "synthetic-operator" && i._context._conversation_id === "synthetic-conversation" });
try {
  await actions.start();
  // This trusted fixture acts as its own caller. Real apps verify identity and
  // explicit consent before binding; never expose bindContext to model output.
  const context = delivery => actions.bindContext({ _actor_id: "synthetic-operator", _conversation_id: "synthetic-conversation", _delivery_id: delivery });
  const proposal = await actions.prepare({ _capability_id: "sample.record", _arguments: { text: "hello" } }, context("request-1"));
  console.log(JSON.stringify({ _proposal: proposal }));
  const confirmation = context("explicit-confirmation-1");
  // Fixture-only consent to the exact displayed hash; real consent is external.
  const result = await actions.confirm({ _action_id: proposal._action_id, _binding_hash: proposal._binding_hash }, confirmation);
  const replay = await actions.confirm({ _action_id: proposal._action_id, _binding_hash: proposal._binding_hash }, confirmation);
  const reconciliation = await actions.reconcile({ _limit: 10 }, confirmation);
  console.log(JSON.stringify({ _result: result, _same_id_replay: replay, _reconciliation: reconciliation,
    _synthetic_target_rows: db.prepare("SELECT count(*) AS n FROM receipts").get().n }));
} finally { await actions.close(); db.close(); }
