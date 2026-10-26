// What the window app, the terminal app and the CLI say about premium tasks that wait for the owner's approval.
export interface AwaitingItem { id: string; task: string; route: string; estimate: number | null; requester: string; deadline: string | null }

export const BACKLOG_TEXT = {
  approve: 'Approve',
  hint: 'Run augur backlog approve <id> --yes to approve it.',
  /** The count line, e.g. "2 premium tasks wait for your approval". */
  count: (n: number): string => `${n} premium ${n === 1 ? 'task waits' : 'tasks wait'} for your approval`,
  /** One waiting item: what it is, who asked, the route it wants and its cost estimate. */
  item: (x: AwaitingItem): string => `${x.task} (${x.requester} wants ${x.route}, about ${x.estimate ?? 1} ${(x.estimate ?? 1) === 1 ? 'point' : 'points'}${x.deadline ? `, due ${x.deadline}` : ''})`,
};
