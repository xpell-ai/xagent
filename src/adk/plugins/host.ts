/** Private policy identity: never inferred from public fields or thrown codes. */
type PluginActionPolicyHost = Readonly<{ beginReconciliation(): () => void }>;
const policies = new WeakMap<object, PluginActionPolicyHost>();
export function registerPluginActionPolicy(policy: object, host: PluginActionPolicyHost): void {
  policies.set(policy, host);
}
export function pluginReconciliationGuard(policy: object | undefined): (() => void) | undefined {
  return policy ? policies.get(policy)?.beginReconciliation() : undefined;
}
