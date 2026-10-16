import { describe, expect, it } from 'vitest';
import { money } from '../src/index.js';

describe('money', () => {
  it('shows dollars with a sign and other plain currency codes after the amount', () => {
    expect(money(12.5)).toBe('$12.50');
    expect(money(12.5, 'EUR')).toMatch(/12.50 EUR$/);
  });
  it('leaves off a currency that is not a plain code, so a provider cannot put markup on the page', () => {
    expect(money(3, '<img src=x onerror=alert(1)>')).not.toMatch(/[<>]/);
    expect(money(3, '')).toMatch(/^3.00$/);
    expect(money(3, 'US D')).toMatch(/^3.00$/);
  });
  it('shows a dash for no amount', () => { expect(money(null)).toBe('-'); expect(money(NaN)).toBe('-'); });
});
