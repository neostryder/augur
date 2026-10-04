// Opens text in the person's own editor ($VISUAL, then $EDITOR, then a platform default) on a temporary file and reads it back, for text
// too long to type into one line, such as custom provider definitions.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface EditorDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Runs the editor command on the file and waits for it to close. Returns false when it could not start or failed. */
  spawn?(command: string, file: string): boolean;
}

export function editorCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return env.VISUAL?.trim() || env.EDITOR?.trim() || (platform === 'win32' ? 'notepad' : platform === 'darwin' ? 'nano' : 'vi');
}

// The command can carry its own arguments, such as "code --wait", so it runs through the shell with the file path quoted after it.
function run(command: string, file: string): boolean {
  const r = spawnSync(`${command} "${file}"`, { stdio: 'inherit', shell: true });
  return !r.error && r.status === 0;
}

/** Resolves to the edited text, or null when the editor failed. `pause` hands the terminal over while the editor runs. */
export async function editText(text: string, name: string, deps: EditorDeps, pause: <T>(fn: () => T | Promise<T>) => Promise<T>): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), 'augur-'));
  const file = join(dir, name);
  try {
    writeFileSync(file, text, 'utf8');
    const ok = await pause(() => (deps.spawn ?? run)(editorCommand(deps.env, deps.platform), file));
    return ok ? readFileSync(file, 'utf8') : null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
