import type { ToolInputSchema } from "../tools.js";

/** Private composition identity, never accepted from serialized/model data. */
export type ActionHost = Readonly<{
  _name: string; _instance_id: string;
  _application_scope: Readonly<{ _env: string; _app_id: string }>;
  _definitions: readonly Readonly<{ _id: string; _description: string; _revision: string; _input_schema: ToolInputSchema }>[];
  check(): void;
}>;
const hosts = new WeakMap<object, ActionHost>();
export function registerActionHost(api: object, host: ActionHost): void { hosts.set(api, host); }
export function actionHost(api: object): ActionHost | undefined { return hosts.get(api); }
