/** Rules for a test fixture. A provider the policy has not seen starts from the starter defaults, where a model is named before use, so a fixture that wants routable models says askFirst false for the providers it does not state it for. */
export function openRules<T>(rules: T): T {
  const copy = structuredClone(rules) as { providers?: Record<string, { defaults?: Record<string, unknown> }> };
  for (const provider of Object.values(copy.providers ?? {})) provider.defaults = { askFirst: false, ...provider.defaults };
  return copy as T;
}
