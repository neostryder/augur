import { describe, expect, it } from 'vitest';
import { emptyEditState } from '@augur/core';
import { heldRows } from '../src/views/rules';

describe('changes waiting for the owner', () => {
  it('lists each held edit with the value the rules have now, and says nothing when none wait', () => {
    expect(heldRows(emptyEditState())).toEqual([]);
    const state = {
      ...emptyEditState(),
      held: [
        { id: 'a', at: '2026-10-01T00:00:00Z', by: 'Claude Admin', provider: 'minimax', model: 'minimax/m3', field: 'dataTier', value: 'internal', reason: 'Most tasks are internal.' },
        { id: 'b', at: '2026-10-01T00:00:00Z', by: 'Claude Admin', provider: 'minimax', model: '', field: 'thresholds.denyPct', value: 95 },
      ],
      results: [{ id: 'a', at: '', status: 'held' as const, provider: 'minimax', model: 'minimax/m3', field: 'dataTier', before: 'public', after: 'internal' }],
    };
    expect(heldRows(state)).toEqual([
      { id: 'a', by: 'Claude Admin', model: 'minimax/m3', field: 'the most sensitive data', before: 'public', value: 'internal', reason: 'Most tasks are internal.' },
      { id: 'b', by: 'Claude Admin', model: 'minimax', field: 'limit: denyPct', before: 'none', value: '95', reason: '' },
    ]);
  });
});
