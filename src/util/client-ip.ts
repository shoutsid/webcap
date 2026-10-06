/**
 * Resolving who is calling.
 *
 * The deployment binds to loopback and the only ingress is the Cloudflare
 * tunnel, so every external request arrives from a *local* peer — the Docker
 * gateway — and `req.ip` is byte-identical for all of them. Keying anything
 * per-caller on that collapses every agent on the internet into one bucket.
 * That is exactly what happened to the free allowance: its per-IP window was
 * really a fleet-wide budget, spent by crawlers before a real agent could try
 * anything, which is the opposite of what the allowance exists to do.
 *
 * So when — and only when — the peer is a private/loopback address, this trusts
 * the client address the tunnel forwarded. The guard is the entire safety
 * argument: a request from a public peer is never allowed to name its own
 * address, so exposing the port directly would not let a caller mint buckets.
 * Cloudflare sets `CF-Connecting-IP` itself and rejects client-supplied copies,
 * so through the tunnel it cannot be forged either.
 *
 * This is deliberately the single place that answers "who is calling" — every
 * per-caller budget should key on `clientIpOf` and nothing else.
 */
import type { FastifyRequest } from 'fastify';

/** `a.b.c.d` -> octets, or null when it is not a valid dotted-quad. */
function ipv4Octets(value: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return null;
  const octets = value.split('.').map((part) => Number(part));
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? octets : null;
}

/** Loopback, RFC1918, link-local, and the IPv6 equivalents (loopback, ULA, link-local). */
export function isPrivateAddress(ip: string): boolean {
  const value = ip.trim().toLowerCase();
  if (value === '') return false;
  const v4 = ipv4Octets(value);
  if (v4 !== null) {
    const a = v4[0] as number;
    const b = v4[1] as number;
    if (a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (value === '::1' || value === '::ffff:127.0.0.1') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(value)) return true;
  return false;
}

/**
 * The first syntactically valid address in a forwarded header value, or null.
 * Anything else (a hostname, a port suffix, junk) is rejected so a malformed
 * header cannot become a bucket key or mint an unlimited number of them.
 */
export function parseForwardedIp(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const first = (raw.split(',')[0] ?? '').trim();
  if (first === '') return null;
  if (ipv4Octets(first) !== null) return first;
  if (first.includes(':') && /^[0-9a-f:]{2,45}$/i.test(first)) return first;
  return null;
}

/**
 * The address to attribute a request to. Falls back to the socket peer, which
 * is what in-process tests (`app.inject`) and direct callers see.
 */
export function clientIpOf(request: FastifyRequest): string {
  const peer = request.ip ?? '';
  if (!isPrivateAddress(peer)) return peer;
  const cf = request.headers['cf-connecting-ip'];
  const fromCf = parseForwardedIp(typeof cf === 'string' ? cf : undefined);
  if (fromCf !== null) return fromCf;
  const xff = request.headers['x-forwarded-for'];
  return parseForwardedIp(Array.isArray(xff) ? xff[0] : xff) ?? peer;
}
