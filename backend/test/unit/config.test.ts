import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from '../../src/platform/config/env.js';

describe('TRUST_PROXY parsing', () => {
  it('defaults to not trusting forwarded headers', () => {
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('never allows unrestricted trust', () => {
    const r = parseTrustProxy('true');
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toMatch(/not allowed/);
  });

  it('accepts a bounded hop count', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('0')).toHaveProperty('error');
    expect(parseTrustProxy('6')).toHaveProperty('error');
  });

  it('accepts proxy addresses and CIDR ranges, and rejects anything else', () => {
    expect(parseTrustProxy('10.0.0.0/8, 172.16.0.0/12')).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
    expect(parseTrustProxy('192.0.2.10')).toEqual(['192.0.2.10']);
    expect(parseTrustProxy('fd00::/8')).toEqual(['fd00::/8']);
    expect(parseTrustProxy('loopback; rm -rf')).toHaveProperty('error');
    expect(parseTrustProxy('*')).toHaveProperty('error');
  });
});
