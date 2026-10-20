import type { Adapter, AdapterCapabilities, AttachmentKind, ExtractInput, Extraction, JobRequest, LaunchPlan, PlanContext, RouteConfig, UsageReport } from '@augur/dispatch-protocol';
import { routeSecretName } from '@augur/dispatch-protocol';
import { scriptPath } from '../paths.js';
import { keyFileOnly, keyFilePath } from '../secrets.js';
import { optNum, optStr } from './util.js';

const SCRIPT = scriptPath(import.meta.url, 'fal-call');
const CAPS: AdapterCapabilities = { permissionRequests: false, sessions: false, reportsUsage: true, sandboxed: false, isolatesWorkspace: false, enforcesReadOnly: true };
const RESOLUTIONS = ['480P', '768P', '1080P'], EXPANSIONS = ['disabled', 'balanced', 'quality'];

/** Null when `text` is a JSON object that gives each resolution it names a price per second of zero or more. */
export function ratesProblem(text: string): string | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return 'usdPerSecondJson must be a JSON object'; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'usdPerSecondJson must be a JSON object';
  for (const [k, n] of Object.entries(v)) if (!RESOLUTIONS.includes(k) || typeof n !== 'number' || !(n >= 0)) return `usdPerSecondJson needs a price of zero or more for each of ${RESOLUTIONS.join(', ')}`;
  return null;
}

/**
 * One video from fal's queue: a prompt, and optionally a first frame, a last frame and an audio track, in; a video file in the job folder out.
 * The cost is the route's own price per second for the resolution times the length, checked against `maxUsd` before anything is sent, and reported as the job's cost.
 * Route options: `endpoint`, `keySource` (`store`, the default, or `env`), `apiKeyEnv`, `resolution`, `duration`, `promptExpansion`, `usdPerSecondJson`, `maxUsd`, `timeoutS`, `maxImageMb`, `maxAudioMb`.
 */
export const falApi: Adapter = {
  id: 'fal-api', charterEngine: null, transport: 'api', capabilities: CAPS, envAllow: [],
  attachmentKinds(): AttachmentKind[] { return ['image', 'audio']; },
  validate(route: RouteConfig) {
    const o = route.options;
    const endpoint = optStr(o, 'endpoint');
    if (!endpoint) return 'route option endpoint is required';
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/.test(endpoint)) return 'endpoint must be a fal endpoint id such as minimax/h3-max-turbo/image-to-video';
    const source = optStr(o, 'keySource') ?? 'store';
    if (source !== 'env' && source !== 'store') return 'keySource must be env or store';
    if (source === 'env' && !optStr(o, 'apiKeyEnv')) return 'route option apiKeyEnv (the environment variable that holds the key) is required';
    const res = optStr(o, 'resolution');
    if (res !== undefined && !RESOLUTIONS.includes(res)) return `resolution must be one of ${RESOLUTIONS.join(', ')}`;
    const ex = optStr(o, 'promptExpansion');
    if (ex !== undefined && !EXPANSIONS.includes(ex)) return `promptExpansion must be one of ${EXPANSIONS.join(', ')}`;
    for (const k of ['duration', 'maxUsd', 'timeoutS', 'maxImageMb', 'maxAudioMb']) { const v = o?.[k]; if (v !== undefined && !(typeof v === 'number' && v > 0)) return `${k} must be a number above zero`; }
    const rates = optStr(o, 'usdPerSecondJson');
    if (rates === undefined) return 'route option usdPerSecondJson is required, so the cost of a job can be checked before it is sent';
    return ratesProblem(rates);
  },
  plan(request: JobRequest, route: RouteConfig, ctx: PlanContext): LaunchPlan {
    if (request.activity !== 'generate_video') throw new Error('a fal video route takes only the generate_video activity.');
    if (request.tools !== 'read' || request.output !== 'text_only') throw new Error('a fal video route returns text and a file in the job folder. Use tools read and output text_only.');
    const o = route.options, files = ctx.attachments ?? [];
    if (files.some(f => f.kind === 'text')) throw new Error('a fal video route takes images and audio, not text files.');
    if (files.filter(f => f.kind === 'image').length > 2 || files.filter(f => f.kind === 'audio').length > 1) throw new Error('a fal video route takes up to two images (first frame, last frame) and one audio file.');
    const argv = [SCRIPT, '--endpoint', optStr(o, 'endpoint') as string, '--out-dir', ctx.jobDir,
      ...(optStr(o, 'keySource') === 'env' ? ['--key-env', optStr(o, 'apiKeyEnv') as string]
        : ['--key-name', routeSecretName(request.route), '--key-file', keyFilePath(), ...(keyFileOnly() ? ['--key-file-only'] : [])]),
      '--resolution', optStr(o, 'resolution') ?? '768P', '--duration', String(optNum(o, 'duration') ?? 5), '--expansion', optStr(o, 'promptExpansion') ?? 'balanced',
      '--rates-json', optStr(o, 'usdPerSecondJson') as string, '--max-usd', String(optNum(o, 'maxUsd') ?? 0.5), '--timeout-s', String(optNum(o, 'timeoutS') ?? request.timeoutS ?? 900),
      ...(files.length ? ['--attachments-json', JSON.stringify(files.map(f => ({ path: f.path, kind: f.kind })))] : [])];
    return { command: process.execPath, args: argv, cwd: request.cwd, env: {}, stdin: ctx.prompt };
  },
  extract(input: ExtractInput): Extraction {
    type Out = { answer?: string; usage?: Omit<UsageReport, 'source'> | null };
    let r: Out | null;
    try { r = JSON.parse(input.stdout) as Out; } catch { r = null; }
    if (!r) return { answer: null, usage: null, failure: input.stderr.trim().split('\n').pop() || 'the fal job returned no result' };
    return { answer: r.answer?.trim() || null, usage: r.usage ? { ...r.usage, source: 'reported' } : null };
  },
};
