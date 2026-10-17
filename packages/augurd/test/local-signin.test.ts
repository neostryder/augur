import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSignInProvider, registerSignInFlow } from '@augur/core';
import { LOCAL_SIGNIN_FILE, loadLocalSignIn } from '../src/local-signin.js';

const dirs: string[] = [];
const home = () => { const d = mkdtempSync(join(tmpdir(), 'augur-signin-')); dirs.push(d); return d; };
afterEach(() => { registerSignInFlow('claude', null); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('local sign-in flows', () => {
  it('add nothing when the home folder has no file', async () => {
    expect(await loadLocalSignIn(home())).toEqual({ added: [], error: null });
    expect(isSignInProvider('claude')).toBe(false);
  });

  it('register the flows the file exports, and skip an export that is not a flow', async () => {
    const d = home();
    writeFileSync(join(d, LOCAL_SIGNIN_FILE), 'const ok = { begin: async () => ({}), complete: async () => ({}), renew: async () => ({}) };\nexport const signInFlows = { claude: ok, codex: { begin: 1 } };\n');
    const r = await loadLocalSignIn(d);
    expect(r.added).toEqual(['claude']);
    expect(r.error).toContain('codex');
    expect(isSignInProvider('claude')).toBe(true);
  });

  it('keep the good flows when one export names a provider Augur cannot sign in to', async () => {
    const d = home();
    writeFileSync(join(d, LOCAL_SIGNIN_FILE), 'const ok = { begin: async () => ({}), complete: async () => ({}), renew: async () => ({}) };\nexport const signInFlows = { grok: ok, claude: ok };\n');
    const r = await loadLocalSignIn(d);
    expect(r.added).toEqual(['claude']);
    expect(r.error).toContain('grok');
  });

  it('report a file that fails to load instead of throwing', async () => {
    const d = home();
    writeFileSync(join(d, LOCAL_SIGNIN_FILE), 'export const signInFlows = ;');
    const r = await loadLocalSignIn(d);
    expect(r.added).toEqual([]);
    expect(r.error).toBeTruthy();
  });
});
