// Checks a minisign signature (the format the Tauri signer writes) with Node's own crypto, against a key pinned in the repository.
// The signature covers the BLAKE2b-512 hash of the file (algorithm "ED"), or the file itself (algorithm "Ed").
import { createHash, createPublicKey, verify } from 'node:crypto';

/** The updater key pinned in apps/desktop/src-tauri/tauri.conf.json: the same key signs the terminal release's checksum list. */
export const PINNED_KEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDYxOTkwMjIwNjcwMDFGMDYKUldRR0h3Qm5JQUtaWWRzY0p2Mkp2aXlQaFU1eEtWa2Zadk1RUWlRZG9KbVZHRS96anBHMnhMR1cK';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const unwrap = (text: string): string => (/^untrusted comment:/i.test(text.trim()) ? text : Buffer.from(text.trim(), 'base64').toString('utf8'));
const dataLine = (text: string, n: number): Buffer | null => {
  const lines = unwrap(text).split(/\r?\n/).filter(l => l.trim() !== '' && !/^(untrusted|trusted) comment:/i.test(l));
  return lines[n] ? Buffer.from(lines[n]!.trim(), 'base64') : null;
};

/** Whether `sig` is a valid signature of `message` by the key `pubkey`. Both arrive as the files hold them, plain or wrapped in base64 once more. */
export function verifyMinisign(message: Buffer | string, sig: string, pubkey: string = PINNED_KEY): boolean {
  try {
    const key = dataLine(pubkey, 0), s = dataLine(sig, 0);
    if (!key || !s || key.length !== 42 || s.length !== 74 || key.toString('latin1', 0, 2) !== 'Ed') return false;
    if (!key.subarray(2, 10).equals(s.subarray(2, 10))) return false;
    const algo = s.toString('latin1', 0, 2);
    if (algo !== 'Ed' && algo !== 'ED') return false;
    const body = typeof message === 'string' ? Buffer.from(message, 'utf8') : message;
    const signed = algo === 'ED' ? createHash('blake2b512').update(body).digest() : body;
    const pub = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, key.subarray(10)]), format: 'der', type: 'spki' });
    return verify(null, signed, pub, s.subarray(10));
  } catch { return false; }
}
