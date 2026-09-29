// Stands in for a harness in tests. Reads directives from standard input, one per line:
//   SLEEP n | WRITE file | EXIT n | GRANDCHILD marker | ESCAPE marker | HANG | ENV NAME | FLOOD mb | SUBMIT-CHILD
// Understands the arguments `codex exec` gets: `-o <file>` receives the final message, and `--json` makes it print a turn.completed event.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const outFile = args.includes('-o') ? args[args.indexOf('-o') + 1] : null;
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', run);
setTimeout(() => { if (!input) run(); }, 400).unref?.();
let started = false;

function run() {
  if (started) return; started = true;
  let sleep = 0, code = 0, hang = false;
  const echo = [];
  for (const line of input.split('\n')) {
    const [cmd, ...rest] = line.trim().split(/\s+/), arg = rest.join(' ');
    if (cmd === 'SLEEP') sleep = Number(arg);
    else if (cmd === 'WRITE') writeFileSync(arg, 'artifact\n');
    else if (cmd === 'EXIT') code = Number(arg);
    else if (cmd === 'HANG') hang = true;
    else if (cmd === 'ENV') echo.push(`ENV ${arg}=${process.env[arg] ?? '<unset>'}`);
    else if (cmd === 'GRANDCHILD') spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', arg], { stdio: 'ignore', windowsHide: true });
    else if (cmd === 'ESCAPE') spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', arg], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (cmd === 'FLOOD') { const chunk = 'héllo 世界 '.repeat(64) + '\n'; for (let i = 0; i < Number(arg) * 1024 * 1024 / chunk.length; i++) process.stdout.write(chunk); }
  }
  if (/^READ-ONLY TASK\./.test(input)) echo.push('TIER read');
  for (const e of echo) console.log(e);
  if (args.includes('--json')) console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 34, reasoning_output_tokens: 5 } }));
  if (outFile) writeFileSync(outFile, 'final message');
  if (hang) { setInterval(() => {}, 1000); return; }
  setTimeout(() => process.exit(code), sleep * 1000);
}
