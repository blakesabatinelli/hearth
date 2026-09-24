/**
 * Router tests.
 *
 * parseHash must collapse:
 *  - empty string, '#', '#/' -> 'home'
 *  - '#/home', '#home', 'home' -> 'home'
 *  - unknown paths -> 'home' (fallback)
 * And the explicit routes pass through.
 */
import { describe, it, expect } from 'vitest';
import { parseHash } from '../src/router';

describe('parseHash', () => {
  it('returns home for empty input', () => {
    expect(parseHash('')).toBe('home');
  });
  it('returns home for just "#"', () => {
    expect(parseHash('#')).toBe('home');
  });
  it('returns home for "#/"', () => {
    expect(parseHash('#/')).toBe('home');
  });
  it('returns home for "#/home"', () => {
    expect(parseHash('#/home')).toBe('home');
  });
  it('returns ask for "#/ask"', () => {
    expect(parseHash('#/ask')).toBe('ask');
  });
  it('returns history for "#/history"', () => {
    expect(parseHash('#/history')).toBe('history');
  });
  it('falls back to home for unknown routes', () => {
    expect(parseHash('#/nope')).toBe('home');
  });
});
