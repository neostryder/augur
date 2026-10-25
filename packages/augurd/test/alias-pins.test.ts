import { describe, expect, it } from 'vitest';
import { checkAliasPin } from '../src/alias-pins.js';

describe('alias provider pin check', () => {
  it('accepts a pin listed for the slug', () => expect(checkAliasPin('DeepInfra', 'vendor/model-2', ['deepinfra'])).toEqual({ ok: true }));
  it('rejects a pin absent from the slug endpoints', () => expect(checkAliasPin('DeepInfra', 'vendor/model-2', ['Together'])).toEqual({ ok: false, reason: 'pinned provider does not serve model' }));
  it('fails closed when endpoint data is absent', () => expect(checkAliasPin('DeepInfra', 'vendor/model-2', undefined)).toEqual({ ok: false, reason: 'pin not verifiable' }));
});
