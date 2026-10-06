import { describe, expect, it } from 'vitest';
import { SUBAGENT_HOOK_ENV, parseSubagentInput, subagentAdvice, subagentHook } from '../src/claude-hook.js';
import type { SubagentHookDeps } from '../src/claude-hook.js';

const input = (over: Record<string, unknown> = {}) => JSON.stringify({ session_id: 's1', tool_name: 'Task', tool_input: { subagent_type: 'general-purpose', description: 'Survey the test files', prompt: 'long text that never leaves' }, ...over });
const deps = (over: Partial<SubagentHookDeps> = {}): SubagentHookDeps => ({
  balance: async () => ({ stance: 'hot', lean: 'Sonnet' }),
  pick: async () => ({ pick: 'codex/sol', reason: 'most room', routes: ['sol'] }), ...over });
const on = { [SUBAGENT_HOOK_ENV]: 'true' };

describe('parseSubagentInput', () => {
  it('reads the session, the description and the subagent type, and never the prompt', () => {
    expect(parseSubagentInput(input())).toEqual({ sessionId: 's1', description: 'Survey the test files', subagentType: 'general-purpose' });
  });
  it('reads anything else as an empty input', () => {
    expect(parseSubagentInput('not json')).toEqual({});
    expect(parseSubagentInput('[1]')).toEqual({});
    expect(parseSubagentInput(JSON.stringify({ tool_input: 4 }))).toEqual({});
  });
});

describe('subagentAdvice', () => {
  it('names the lean and the pick', () => {
    const note = subagentAdvice({ subagentType: 'Explore' }, { stance: 'hot', lean: 'Sonnet' }, { pick: 'codex/sol', reason: 'most room', routes: ['sol', 'sol2'] }) as string;
    expect(note).toContain('(Explore)');
    expect(note).toContain('Claude is hot');
    expect(note).toContain('Augur picks codex/sol (most room)');
    expect(note).toContain('augur_run on sol, sol2');
  });
  it('stays quiet when Claude is on pace and nothing is picked', () => {
    expect(subagentAdvice({}, { stance: 'on pace', lean: 'neither' }, { pick: null })).toBeNull();
    expect(subagentAdvice({}, null, null)).toBeNull();
  });
});

describe('subagentHook', () => {
  it('prints nothing while the option is off', async () => {
    expect(await subagentHook(input(), {}, deps())).toBe('');
    expect(await subagentHook(input(), { [SUBAGENT_HOOK_ENV]: 'false' }, deps())).toBe('');
  });
  it('adds context and never a permission decision', async () => {
    const out = JSON.parse(await subagentHook(input(), on, deps())) as { hookSpecificOutput: Record<string, string> };
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('codex/sol');
    expect(out.hookSpecificOutput).not.toHaveProperty('permissionDecision');
    expect(out.hookSpecificOutput).not.toHaveProperty('updatedInput');
  });
  it('sends the service only the description and the session', async () => {
    const seen: unknown[] = [];
    await subagentHook(input(), on, deps({ pick: async (task, session) => { seen.push(task, session); return null; } }));
    expect(seen).toEqual(['Survey the test files', 's1']);
  });
  it('prints nothing when the service fails', async () => {
    const down = deps({ balance: async () => { throw new Error('down'); }, pick: async () => { throw new Error('down'); } });
    expect(await subagentHook(input(), on, down)).toBe('');
  });
  it('also turns on from AUGUR_PICK_BEFORE_SUBAGENT', async () => {
    expect(await subagentHook(input(), { AUGUR_PICK_BEFORE_SUBAGENT: '1' }, deps())).toContain('additionalContext');
  });
});
