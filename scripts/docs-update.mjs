// Rewrites the generated tables in docs/configuring.md from the code. Review the diff afterwards.
import { spawnSync } from 'node:child_process';

const run = spawnSync('pnpm', ['--filter', '@augur/dispatch-protocol', 'exec', 'vitest', 'run', 'test/docs-parity.test.ts'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, UPDATE_DOCS: '1' },
});
process.exit(run.status ?? 1);
