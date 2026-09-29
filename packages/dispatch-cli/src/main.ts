import { readFileSync } from 'node:fs';
import { main } from './cli.js';

const code = await main(process.argv.slice(2), {
  out: t => { process.stdout.write(t); }, err: t => { process.stderr.write(t); },
  stdin: () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } },
  env: process.env, cwd: process.cwd(),
});
process.exit(code);
