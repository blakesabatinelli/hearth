import { describe, expect, it } from 'vitest';
import { authorizeRequest } from '../access-policy.mjs';

const allowed = new Set(['owner@example.com']);

describe('production gateway access policy', () => {
  it('allows a host-local browser without a Tailscale identity', () => {
    expect(authorizeRequest({ remoteAddress: '::ffff:127.0.0.1', host: '127.0.0.1:5174' }, allowed)).toBe(true);
    expect(authorizeRequest({ remoteAddress: '::1', host: 'localhost:5174' }, allowed)).toBe(true);
  });

  it('requires an allowed identity for a Serve request proxied from loopback', () => {
    expect(authorizeRequest({
      remoteAddress: '127.0.0.1', host: 'hearth-host.example.ts.net',
    }, allowed)).toBe(false);
    expect(authorizeRequest({
      remoteAddress: '127.0.0.1', host: 'hearth-host.example.ts.net',
      tailscaleLogin: 'owner@example.com',
    }, allowed)).toBe(true);
  });

  it('denies unlisted or non-local requests', () => {
    expect(authorizeRequest({
      remoteAddress: '127.0.0.1', host: 'localhost:5174',
      tailscaleLogin: 'guest@example.com',
    }, allowed)).toBe(false);
    expect(authorizeRequest({ remoteAddress: '192.0.2.4', host: 'localhost:5174' }, allowed)).toBe(false);
  });
});
