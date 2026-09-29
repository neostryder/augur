import { readFileSync, statSync } from 'node:fs';
import { tierNote } from '@augur/dispatch-protocol';
import type { Adapter, ExtractInput, Extraction, JobRequest, LaunchPlan, PlanContext, RouteConfig, UsageReport } from '@augur/dispatch-protocol';
import { insidePath, sandboxOptions, sbxCommand, sbxPrefix, workRoot } from './sandbox.js';
import { optStr } from './util.js';

/** A long prompt is put in a file in the job folder, since the command line is limited. */
const INLINE_LIMIT = 8000;
const TASK_FILE = '.ai-task.md';

interface OpencodeEvent { type?: string; part?: { type?: string; text?: string; reason?: string; cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } } }

/**
 * OpenCode (`opencode run`) inside a Docker Sandboxes sandbox, on a copy of the working directory. What it changes comes back as a patch.
 * Route options: `sandbox`, `workRoot`, `model` (provider/model), `sbx`, `envAllow`.
 */
export const opencodeSbx: Adapter = {
  id: 'opencode-sbx', transport: 'exec',
  capabilities: { permissionRequests: false, sessions: false, reportsUsage: true, sandboxed: true, isolatesWorkspace: true, enforcesReadOnly: false },
  envAllow: [],
  isolation: { root: workRoot },
  validate: sandboxOptions,
  plan(request: JobRequest, route: RouteConfig, ctx: PlanContext): LaunchPlan {
    const sbx = sbxCommand(route) as string, ws = ctx.workspace as string;
    const framed = tierNote(request.tools === 'read' ? 'read' : 'full', ctx.prompt), files: NonNullable<LaunchPlan['files']> = [];
    let message = framed;
    if (framed.length > INLINE_LIMIT) {
      files.push({ name: TASK_FILE, content: framed, inWorkspace: true });
      message = `Your complete task is in the file ${TASK_FILE} in the current directory. Read it in full and follow it. Do not edit or delete that file.`;
    }
    const args = [...sbxPrefix(route), 'exec', '-e', 'NO_COLOR=1', '-w', insidePath(ws), optStr(route.options, 'sandbox') as string, 'opencode', 'run', '--format', 'json', '--model', optStr(route.options, 'model') as string, message];
    return { command: sbx, args, cwd: request.cwd, env: {}, stdin: null, files, promptArgs: [args.length - 1] };
  },
  extract(input: ExtractInput): Extraction {
    // The whole transcript is read, since the token counts are spread over every step.
    return readEvents(input.stdoutPath, input.stdout);
  },
};

/** Reads the whole captured output, up to 64 MB, and otherwise the tail the service passed in. */
function transcript(path: string, tail: string): string {
  try { return statSync(path).size <= 64 * 1024 * 1024 ? readFileSync(path, 'utf8') : tail; } catch { return tail; }
}

function readEvents(path: string, fallback: string): Extraction {
  const all: string[] = [];
  let texts: string[] = [];
  let input = 0, output = 0, reasoning = 0, read = 0, write = 0, cost = 0, steps = 0, costSeen = false;
  const take = (line: string) => {
    if (!line.startsWith('{')) return;
    let e: OpencodeEvent;
    try { e = JSON.parse(line) as OpencodeEvent; } catch { return; }
    if (e.type === 'step_start') texts = [];
    if (e.type === 'text' && e.part?.text) { texts.push(e.part.text); all.push(e.part.text); }
    if (e.type === 'step_finish' && e.part?.tokens) {
      const t = e.part.tokens; steps++;
      input += t.input ?? 0; output += t.output ?? 0; reasoning += t.reasoning ?? 0; read += t.cache?.read ?? 0; write += t.cache?.write ?? 0;
      if (typeof e.part.cost === 'number') { cost += e.part.cost; costSeen = true; }
    }
  };
  for (const line of transcript(path, fallback).split(String.fromCharCode(10))) take(line.trim());
  // The answer is the last step's text; earlier steps are narration between tool calls.
  const answer = (texts.length ? texts : all).join('\n').trim() || null;
  if (!steps) return { answer, usage: null };
  const usage: UsageReport = { inputTokens: input + read + write, outputTokens: output, source: 'reported' };
  if (read) usage.cachedReadTokens = read;
  if (write) usage.cachedWriteTokens = write;
  if (reasoning) usage.reasoningTokens = reasoning;
  if (costSeen) { usage.costUsd = Math.round(cost * 1e6) / 1e6; usage.currency = 'USD'; }
  return { answer, usage };
}
