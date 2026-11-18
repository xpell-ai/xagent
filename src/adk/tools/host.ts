import type { TrustedToolContext } from "../tools.js";
/** Private T1 composition seam: current invoke policy, no handler or receipt mutation. */
export type ReadRegistryHost = Readonly<{
  reauthorize(call: unknown, context: TrustedToolContext): Promise<void>;
}>;
const hosts = new WeakMap<object, ReadRegistryHost>();
export function registerReadRegistry(api: object, host: ReadRegistryHost): void { hosts.set(api, host); }
export function readRegistryHost(api: object): ReadRegistryHost | undefined { return hosts.get(api); }
