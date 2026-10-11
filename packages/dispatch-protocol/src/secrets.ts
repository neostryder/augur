// Where a route's API key is kept. The desktop app writes it to the operating system's credential store under the name below, and the service's
// API caller reads it from there when a job starts, so the key never sits in routes.json, the job record, or the service's environment.

/**
 * The secret name for a route's key: `dispatch.` and the route name with `_` written `_u` and `-` written `_d`, so two route names never share a name
 * and the name fits the desktop app's `<provider>.<field>` secret format.
 */
export function routeSecretName(route: string): string {
  return `dispatch.${route.replace(/_/g, '_u').replace(/-/g, '_d')}`;
}

/** The credential's name in the Windows Credential Manager, where the app's secrets are stored as `<name>.augur`. */
export const credentialTarget = (secretName: string): string => `${secretName}.augur`;

/** Option names a profile or an agent route refuses. A profile and a route file never carry a key. */
export const SECRET_OPTION = /^(api_?key|key|token|secret|password)$/i;

/** A string that is itself a key, rather than an option whose name looks like one. */
export function looksLikeSecretValue(value: string): boolean {
  const v = value.trim();
  return /^(sk|rk|pk|ghp|github_pat|xox[baprs])[-_]/i.test(v) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v);
}
