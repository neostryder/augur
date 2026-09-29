// Builds the Job Object launcher the service uses on Windows. Needs the Go toolchain; the binary lands in native/bin.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
if (process.platform !== 'win32') { console.log('jobhost is only used on Windows.'); process.exit(0); }
mkdirSync(join(here, 'bin'), { recursive: true });
execFileSync('go', ['build', '-ldflags', '-H=windowsgui -s -w', '-o', join(here, 'bin', 'jobhost.exe'), '.'], { cwd: join(here, 'jobhost'), stdio: 'inherit', windowsHide: true });
console.log('built native/bin/jobhost.exe');
