// The wording and small rules the Dispatch pages share: how a job's state, tools and output are named, how long a job took, and what the
// service's modes and task classifiers mean. The window app and the terminal app show these as they are.
import type { JobRecord, JobState } from '@augur/dispatch-protocol';

export const STATE_LABELS: Record<JobState, string> = {
  queued: 'Queued', needs_approval: 'Needs approval', running: 'Running', cancel_requested: 'Cancelling', completed: 'Done', failed: 'Failed',
  artifact_validation_failed: 'Output check failed', cancelled: 'Cancelled', killed: 'Stopped', lost: 'Lost',
};

const LIVE = new Set<JobState>(['queued', 'needs_approval', 'running', 'cancel_requested']);
const BAD = new Set<JobState>(['failed', 'artifact_validation_failed', 'killed', 'lost']);

export const isLive = (state: JobState): boolean => LIVE.has(state);
export const isBad = (state: JobState): boolean => BAD.has(state);

export const TOOL_LABELS: Record<string, string> = { read: 'Reads only', write: 'Can write', full: 'Full access' };
export const JOB_OUTPUT_LABELS: Record<string, string> = { write_files: 'Writes files', patch_only: 'Returns a patch', text_only: 'Text only' };

export function duration(job: JobRecord, now = Date.now()): string {
  if (!job.startedAt) return '';
  const s = Math.max(0, Math.round(((job.endedAt ?? now) - job.startedAt) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const MODE_TEXT = {
  usage: 'Augur shows your plan usage and keeps your model rules. It does not run jobs.',
  jobs: 'Augur also runs a service on this computer. Agents start jobs with the augur command, and Augur picks the model from your rules and current usage.',
};

/** What each choice for the task classifier means for where task text goes. */
export const CLASSIFIER_TEXT: Record<string, string> = {
  none: 'Nothing classifies tasks. Agents give augur pick the activity and data tier themselves.',
  laya: 'Laya runs on your own computers, so task text stays on your network. Installing it is optional; the README has the steps.',
  jev: 'Jev is a hosted service from TypeSafe. With it on, the text of each task given to augur pick --task is sent there using your key. Text about students is checked on this computer first and never sent.',
};

export const DISPATCH_TEXT = {
  jobsEmpty: 'No jobs yet. Agents start them with the augur command.',
  jobsPick: 'Pick a job to see its result and output.',
  routesEmpty: 'No routes yet. A route joins a model to the program that runs it.',
  routesPick: 'Pick a route to edit it, or add one.',
  serviceRunning: (pid: number | null) => `Service running${pid ? ` (process ${pid})` : ''}.`,
  serviceStopped: 'Service stopped.',
  settingsNote: 'A running service reads these when it next starts.',
  settingSaved: 'Saved. Restart the service to use it.',
  changeByHand: 'Change it with augur config set, or in config.json.',
  skipped: (n: number) => `The service skips ${n === 1 ? 'one entry' : `${n} entries`}`,
  skippedWhy: 'A route needs a lowercase name, a model and an adapter. Saving here keeps them as they are.',
  fileBad: 'routes.json cannot be used.',
  keyStored: "A key is saved in this computer's key store. A new one replaces it, and the route file never holds it.",
  keyNone: 'No key is saved yet.',
  keySaved: "The key is saved in this computer's key store.",
  keyGone: 'The key was removed.',
  keyNameFirst: 'Give the route a valid name first.',
  keyEmpty: 'Paste the key first.',
  testRunning: 'Testing',
  testWorks: (name: string, answer: string | null) => `${name} works. The model answered${answer ? `: ${answer.trim().slice(0, 80)}` : '.'}`,
  testFailed: (name: string, why: string) => `${name} did not work. ${why}`,
  testSlow: (name: string) => `${name} had not finished after 2.5 minutes. Its job is still on the Jobs page.`,
};
