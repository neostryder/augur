// A child gets the platform basics, the variables its adapter names and the extras the plan adds. Nothing else from the service's environment.

const BASICS_WIN = ['SystemRoot', 'SystemDrive', 'PATH', 'PATHEXT', 'ComSpec', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  'USERNAME', 'USERDOMAIN', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'windir', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'LANG'];
const BASICS_POSIX = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];

export function buildEnv(allow: readonly string[], extra: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const wanted = new Set([...(process.platform === 'win32' ? BASICS_WIN : BASICS_POSIX), ...allow].map(n => n.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) if (value !== undefined && wanted.has(name.toLowerCase())) out[name] = value;
  return { ...out, ...extra };
}
