// `augur claude hook subagent`: the command behind the Claude Code plugin's pick-before-subagent hook. Claude Code runs it before the Task tool starts a subagent and
// reads one JSON object from its output. It only ever adds a note for Claude to read. It never allows, denies or changes the call, so the person's own permission
// settings stay in charge, and any failure leaves the call exactly as it was.

/** The plugin's `pick_before_subagent` option, which Claude Code exports to a hook as this variable. The hook does nothing until it is on. */
export const SUBAGENT_HOOK_ENV = 'CLAUDE_PLUGIN_OPTION_PICK_BEFORE_SUBAGENT';

export interface SubagentHookInput { sessionId?: string; description?: string; subagentType?: string }
export interface ClaudeLean { stance: string; lean: string }
export interface HookPick { pick: string | null; reason?: string; routes?: readonly string[] }
export interface SubagentHookDeps {
  /** Claude's pace and which way the controller leans. Null when the service cannot say. */
  balance(): Promise<ClaudeLean | null>;
  /** Augur's pick for a task described in a few words. Null when the service cannot say. */
  pick(task: string, session: string | undefined): Promise<HookPick | null>;
}

const isOn = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());
export const subagentHookOn = (env: NodeJS.ProcessEnv): boolean => isOn(env[SUBAGENT_HOOK_ENV]) || isOn(env.AUGUR_PICK_BEFORE_SUBAGENT);

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim() : undefined;

/** Reads the hook's standard input. Anything that is not the expected shape reads as an input with nothing in it. */
export function parseSubagentInput(text: string): SubagentHookInput {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return {}; }
  if (!isObj(data)) return {};
  const tool = isObj(data.tool_input) ? data.tool_input : {};
  return { ...(str(data.session_id) ? { sessionId: str(data.session_id) as string } : {}), ...(str(tool.description) ? { description: str(tool.description) as string } : {}), ...(str(tool.subagent_type) ? { subagentType: str(tool.subagent_type) as string } : {}) };
}

/** The note Claude reads before it starts the subagent. It names the model Augur would pick and the controller's lean, and leaves the choice to Claude. */
export function subagentAdvice(input: SubagentHookInput, claude: ClaudeLean | null, pick: HookPick | null): string | null {
  const parts: string[] = [];
  if (claude && claude.stance !== 'on pace') parts.push(`Claude is ${claude.stance} on its usage, and Augur leans to ${claude.lean} for the work it spreads.`);
  if (pick?.pick) {
    const routes = (pick.routes ?? []).join(', ');
    parts.push(`For this subagent Augur picks ${pick.pick}${pick.reason ? ` (${pick.reason})` : ''}.${routes ? ` Run it with augur_run on ${routes}, or keep the subagent as planned.` : ''}`);
  }
  if (!parts.length) return null;
  return `Augur, before a subagent${input.subagentType ? ` (${input.subagentType})` : ''}: ${parts.join(' ')}`;
}

/** The text the hook prints, or an empty string when it has nothing to add. */
export async function subagentHook(stdin: string, env: NodeJS.ProcessEnv, deps: SubagentHookDeps): Promise<string> {
  if (!subagentHookOn(env)) return '';
  const input = parseSubagentInput(stdin);
  try {
    const [claude, pick] = await Promise.all([deps.balance().catch(() => null), input.description ? deps.pick(input.description, input.sessionId).catch(() => null) : Promise.resolve(null)]);
    const note = subagentAdvice(input, claude, pick);
    return note ? `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: note } })}\n` : '';
  } catch { return ''; }
}
