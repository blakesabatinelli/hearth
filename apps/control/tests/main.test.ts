/**
 * Tests for the control-service bootstrap glue (env wiring).
 *
 * Most behavior is exercised through the existing end-to-end suite.
 * This file covers the bits that don't have a clean in-process
 * surface: env-driven setup, loopback guard failures, and the
 * `bonsai_disabled` switch.
 */

import { describe, it, expect, beforeEach } from 'vitest';

describe('resolveBonsaiProvider', () => {
  let home: NodeJS.ProcessEnv;
  beforeEach(() => {
    home = { ...process.env };
  });

  it('returns {} when no env is set (no bonsai provider)', async () => {
    delete home['HEARTH_OPENCLAW_URL'];
    delete home['HEARTH_GATEWAY_TOKEN'];
    delete home['HEARTH_BONSAI_DISABLED'];
    process.env = home;
    const { resolveBonsaiProvider } = await import('../src/main.js');
    const out = resolveBonsaiProvider();
    expect('bonsai' in out).toBe(false);
  });

  it('returns {} when only URL is set', async () => {
    home['HEARTH_OPENCLAW_URL'] = 'http://127.0.0.1:8443';
    delete home['HEARTH_GATEWAY_TOKEN'];
    process.env = home;
    const { resolveBonsaiProvider } = await import('../src/main.js');
    const out = resolveBonsaiProvider();
    expect('bonsai' in out).toBe(false);
  });

  it('returns {} when HEARTH_BONSAI_DISABLED=1 even if both URLs are set', async () => {
    home['HEARTH_OPENCLAW_URL'] = 'http://127.0.0.1:8443';
    home['HEARTH_GATEWAY_TOKEN'] = 'tok';
    home['HEARTH_BONSAI_DISABLED'] = '1';
    process.env = home;
    const { resolveBonsaiProvider } = await import('../src/main.js');
    const out = resolveBonsaiProvider();
    expect('bonsai' in out).toBe(false);
  });

  it('returns {} when URL is non-loopback (refuses to wire remote gateway)', async () => {
    home['HEARTH_OPENCLAW_URL'] = 'http://test-1.example.com:8443';
    home['HEARTH_GATEWAY_TOKEN'] = 'tok';
    delete home['HEARTH_BONSAI_DISABLED'];
    process.env = home;
    const { resolveBonsaiProvider } = await import('../src/main.js');
    // Suppress console.warn for this test
    const orig = console.warn;
    console.warn = () => {};
    try {
      const out = resolveBonsaiProvider();
      expect('bonsai' in out).toBe(false);
    } finally {
      console.warn = orig;
    }
  });

  it('returns a provider when URL is loopback and token is set', async () => {
    home['HEARTH_OPENCLAW_URL'] = 'http://127.0.0.1:8443';
    home['HEARTH_GATEWAY_TOKEN'] = 'tok-abc';
    delete home['HEARTH_BONSAI_DISABLED'];
    process.env = home;
    const { resolveBonsaiProvider } = await import('../src/main.js');
    const out = resolveBonsaiProvider();
    expect('bonsai' in out && !!out.bonsai).toBe(true);
  });
});
