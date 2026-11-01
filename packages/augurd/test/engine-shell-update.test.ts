import { describe, expect, it } from 'vitest';
import { shouldOfferUpdate } from '../src/engine-shell.js';

describe('update channel versions', () => {
  it('does not offer an Early build unless it is newer than Stable and installed versions', () => {
    expect(shouldOfferUpdate('early', '1.17.0-edge.9', '1.16.0', '1.17.0')).toBe(false);
    expect(shouldOfferUpdate('early', '1.17.0-edge.10', '1.16.0', '1.17.0-edge.9')).toBe(true);
    expect(shouldOfferUpdate('stable', '1.17.0', '1.16.0')).toBe(true);
  });
});
