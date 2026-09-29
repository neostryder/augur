// Job lifecycle shared by the service, the CLI and the interface.

export const JOB_STATES = ['queued', 'needs_approval', 'running', 'cancel_requested', 'completed', 'failed',
  'artifact_validation_failed', 'cancelled', 'killed', 'lost'] as const;
export type JobState = typeof JOB_STATES[number];

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>(['completed', 'failed', 'artifact_validation_failed', 'cancelled', 'killed', 'lost']);
export const isTerminal = (state: JobState): boolean => TERMINAL_STATES.has(state);

const NEXT: Record<JobState, readonly JobState[]> = {
  queued: ['needs_approval', 'running', 'cancelled', 'failed', 'lost'],
  needs_approval: ['queued', 'cancelled', 'failed'],
  running: ['cancel_requested', 'completed', 'failed', 'artifact_validation_failed', 'cancelled', 'killed', 'lost'],
  cancel_requested: ['cancelled', 'completed', 'failed', 'artifact_validation_failed', 'killed', 'lost'],
  completed: [], failed: [], artifact_validation_failed: [], cancelled: [], killed: [], lost: [],
};
export const canTransition = (from: JobState, to: JobState): boolean => NEXT[from].includes(to);
/** States a job may leave for `to`, used to make a transition a single conditional update. */
export const statesBefore = (to: JobState): JobState[] => JOB_STATES.filter(s => NEXT[s].includes(to));

export const EVENT_KINDS = ['requested', 'policy_evaluated', 'queued', 'approval_requested', 'process_created', 'protocol_initialized',
  'prompt_accepted', 'first_update', 'first_tool', 'permission_requested', 'cancellation_requested', 'cancellation_acknowledged',
  'process_exited', 'artifact_validated', 'usage_recorded', 'reconciled', 'finalized'] as const;
export type EventKind = typeof EVENT_KINDS[number];

/** Process exit codes of the `augur` CLI. */
export const EXIT_CODES = { completed: 0, usage: 1, rejected: 2, needs_approval: 3, failed: 4, artifact_validation_failed: 5, cancelled: 6, lost: 7, wait_timeout: 124 } as const;

export function exitCodeForState(state: JobState): number {
  switch (state) {
    case 'completed': return EXIT_CODES.completed;
    case 'needs_approval': return EXIT_CODES.needs_approval;
    case 'artifact_validation_failed': return EXIT_CODES.artifact_validation_failed;
    case 'cancelled': case 'cancel_requested': return EXIT_CODES.cancelled;
    case 'lost': return EXIT_CODES.lost;
    default: return EXIT_CODES.failed;
  }
}
