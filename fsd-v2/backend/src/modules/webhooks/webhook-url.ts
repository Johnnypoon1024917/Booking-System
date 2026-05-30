import * as dns from 'node:dns/promises';
import * as net from 'node:net';

// SSRF allowlist for webhook target URLs. Mirrors v1's
// src/infrastructure/safehttp.ValidateExternalURL semantics:
//
//   - https only (http allowed if WEBHOOK_ALLOW_HTTP=true for dev)
//   - no userinfo (https://user:pw@host)
//   - host must not be a literal RFC1918 / loopback / link-local IP
//   - host must not be the AWS / GCP / Azure metadata services
//   - if host is a name, every resolved A/AAAA must pass the same checks
//
// Throws Error with a human-readable reason. Callers convert to
// BadRequestException at the controller boundary.

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.azure.com',
]);

// AWS / OpenStack instance metadata. Hard-block whether requested by name
// or by IP literal.
const BLOCKED_IPS = new Set([
  '169.254.169.254',
  'fd00:ec2::254',
]);

export async function validateWebhookTargetURL(raw: string): Promise<void> {
  if (!raw) throw new Error('empty url');
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('not a valid url'); }

  const allowHttp = String(process.env.WEBHOOK_ALLOW_HTTP).toLowerCase() === 'true';
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) {
    throw new Error('only https is allowed');
  }
  if (u.username || u.password) throw new Error('userinfo in url is not allowed');
  const host = u.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) throw new Error(`hostname ${host} is blocked`);

  if (net.isIP(host)) {
    assertSafeIP(host);
    return;
  }

  // Resolve every A/AAAA and check each — a single private record is a
  // rebinding vector and must reject the whole URL.
  let addrs: { address: string; family: number }[] = [];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (e: any) {
    throw new Error(`dns lookup failed for ${host}: ${e?.message || e}`);
  }
  if (addrs.length === 0) throw new Error(`no dns records for ${host}`);
  for (const a of addrs) assertSafeIP(a.address);
}

function assertSafeIP(addr: string): void {
  if (BLOCKED_IPS.has(addr)) throw new Error(`ip ${addr} is blocked (cloud metadata)`);
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    if (a === 10) throw new Error('rfc1918 10.0.0.0/8');
    if (a === 172 && b >= 16 && b <= 31) throw new Error('rfc1918 172.16.0.0/12');
    if (a === 192 && b === 168) throw new Error('rfc1918 192.168.0.0/16');
    if (a === 127) throw new Error('loopback');
    if (a === 169 && b === 254) throw new Error('link-local');
    if (a === 0) throw new Error('reserved 0.0.0.0/8');
    if (a >= 224) throw new Error('multicast / reserved');
    return;
  }
  if (net.isIPv6(addr)) {
    const lower = addr.toLowerCase();
    if (lower === '::1') throw new Error('ipv6 loopback');
    if (lower.startsWith('fc') || lower.startsWith('fd')) throw new Error('ipv6 ULA');
    if (lower.startsWith('fe80')) throw new Error('ipv6 link-local');
    return;
  }
  throw new Error(`unrecognized address ${addr}`);
}
