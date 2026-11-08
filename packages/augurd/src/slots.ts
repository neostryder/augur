/** Adapters whose jobs finish in seconds: a direct API call. Every other adapter runs an agent or a browser chat that can take half an hour. */
export const QUICK_ADAPTERS = new Set(['anthropic-api', 'openai-api']);

/**
 * Counts the job slots in one scheduling pass. A long job may fill all but `reserve` slots, so a quick job always finds one
 * free while long jobs are queued. Quick jobs may use any free slot.
 */
export class Slots {
  private total = 0;
  private long = 0;
  private readonly longLimit: number;

  constructor(private readonly max: number, reserve: number, active: Iterable<boolean>) {
    this.longLimit = Math.max(1, max - Math.max(0, reserve));
    for (const quick of active) this.take(quick);
  }

  /** Whether a job of this kind may start now. */
  canTake(quick: boolean): boolean {
    return this.total < this.max && (quick || this.long < this.longLimit);
  }

  take(quick: boolean): void {
    this.total++;
    if (!quick) this.long++;
  }

  get free(): number { return this.max - this.total; }
}
