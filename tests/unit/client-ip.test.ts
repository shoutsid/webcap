/**
 * Resolving the caller is what the allowance, the register limiter, the preview
 * limiter and the watch limiter all key on, and the whole point is the guard:
 * a forwarded address is believed only when the socket peer is local. Get that
 * backwards and either every caller shares one bucket again (the 2026-10-06
 * bug) or any caller can mint unlimited ones.
 */
import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { clientIpOf, isPrivateAddress, parseForwardedIp } from '../../src/util/client-ip.js';

/** A request stub carrying only what clientIpOf reads. */
function req(ip: string, headers: Record<string, string> = {}): FastifyRequest {
  return { ip, headers } as unknown as FastifyRequest;
}

describe('isPrivateAddress', () => {
  it('accepts loopback, RFC1918, link-local and their IPv6 forms', () => {
    for (const ip of ['127.0.0.1', '172.21.0.1', '10.1.2.3', '192.168.0.5', '169.254.10.1', '::1', 'fc00::1', 'fd12::2', 'fe80::1']) {
      expect(isPrivateAddress(ip), `${ip} should be private`).toBe(true);
    }
  });

  it('rejects public addresses and junk', () => {
    for (const ip of ['8.8.8.8', '203.0.113.7', '172.32.0.1', '192.169.0.1', '999.1.1.1', '', 'localhost']) {
      expect(isPrivateAddress(ip), `${ip} should not be private`).toBe(false);
    }
  });
});

describe('parseForwardedIp', () => {
  it('takes the first address of a list', () => {
    expect(parseForwardedIp('203.0.113.7')).toBe('203.0.113.7');
    expect(parseForwardedIp('203.0.113.7, 10.0.0.1')).toBe('203.0.113.7');
    expect(parseForwardedIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('rejects anything that is not an address', () => {
    for (const raw of [undefined, '', '   ', 'not-an-ip', 'example.com', '203.0.113.7:443', '999.0.0.1']) {
      expect(parseForwardedIp(raw as string | undefined), `${String(raw)} should be rejected`).toBeNull();
    }
  });
});

describe('clientIpOf', () => {
  it('trusts the forwarded client address from a local peer (the tunnel)', () => {
    expect(clientIpOf(req('172.21.0.1', { 'cf-connecting-ip': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientIpOf(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('never trusts a forwarded address from a public peer', () => {
    // Otherwise a directly-connected caller could name its own address and mint
    // an unlimited number of buckets.
    expect(clientIpOf(req('198.51.100.1', { 'cf-connecting-ip': '10.0.0.1' }))).toBe('198.51.100.1');
    expect(clientIpOf(req('198.51.100.1', { 'x-forwarded-for': '10.0.0.1' }))).toBe('198.51.100.1');
  });

  it('falls back to the socket peer when nothing usable was forwarded', () => {
    expect(clientIpOf(req('172.21.0.1'))).toBe('172.21.0.1');
    expect(clientIpOf(req('172.21.0.1', { 'cf-connecting-ip': 'not-an-ip' }))).toBe('172.21.0.1');
    // A malformed CF header must not stop a usable X-Forwarded-For being read.
    expect(clientIpOf(req('172.21.0.1', { 'cf-connecting-ip': 'junk', 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9');
  });
});
