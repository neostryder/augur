import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Runs a synchronous file update while holding an exclusive sibling lock. */
export function withFileLock<T>(target: string, update: () => T): T {
  const lock = `${target}.lock`, started = Date.now();
  mkdirSync(dirname(target), { recursive: true });
  let fd: number | null = null;
  while (fd === null) {
    try { fd = openSync(lock, 'wx'); writeFileSync(fd, `${process.pid}\n`); }
    catch (error) {
      if (fd !== null) { closeSync(fd); fd = null; try { unlinkSync(lock); } catch { /* another process removed it */ } }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (existsSync(lock)) {
          const age = Date.now() - statSync(lock).mtimeMs;
          const pid = Number(readFileSync(lock, 'utf8').trim());
          let dead = false;
          if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === 'ESRCH'; } }
          if (dead || age > 30000) unlinkSync(lock);
        }
      } catch { /* a concurrent owner changed the lock */ }
      if (Date.now() - started >= 2000) {
        let age = 0; try { age = Date.now() - statSync(lock).mtimeMs; } catch { /* lock was removed */ }
        throw new Error(`Timed out waiting for ${lock} (age ${Math.max(0, Math.floor(age / 1000))}s).`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return update(); } finally { closeSync(fd); try { unlinkSync(lock); } catch { /* the lock is already gone */ } }
}
