/**
 * SSRF protection guard for outbound URL fetching (link previews).
 *
 * Validates that a URL points at a public, externally reachable host before
 * the server performs a request. Blocks loopback, private, link-local,
 * cloud metadata, CGNAT, multicast and reserved address space for both
 * IPv4 and IPv6, and resolves hostnames via DNS before allowing a fetch.
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';

export class UrlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlGuardError';
  }
}

/** Thrown when DNS resolution fails — callers fall back to a hostname-only preview. */
export class UrlResolutionError extends Error {
  constructor(hostname: string) {
    super(`Could not resolve host: ${hostname}`);
    this.name = 'UrlResolutionError';
  }
}

interface CidrRange {
  cidr: string;
  start: bigint;
  size: bigint; // number of addresses in the range
}

function ipv4Cidr(cidr: string): CidrRange {
  const [addr, bitsRaw] = cidr.split('/');
  const bits = BigInt(bitsRaw);
  const start = ipv4ToBigInt(addr);
  const size = 1n << (32n - bits);
  return { cidr, start, size };
}

function ipv4ToBigInt(ip: string): bigint {
  const parts = ip.split('.');
  if (parts.length !== 4) return 0n;
  let value = 0n;
  for (const part of parts) {
    value = (value << 8n) + BigInt(Number(part));
  }
  return value;
}

// RFC1918, loopback, link-local, CGNAT, multicast, reserved, and documentation ranges.
const PRIVATE_V4_RANGES: CidrRange[] = [
  '0.0.0.0/8', // "this" network
  '10.0.0.0/8', // RFC1918 private
  '100.64.0.0/10', // RFC6598 CGNAT (cloud metadata services also live here)
  '127.0.0.0/8', // IPv4 loopback
  '169.254.0.0/16', // link-local (AWS/GCP/Azure instance metadata: 169.254.169.254)
  '172.16.0.0/12', // RFC1918 private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1 documentation
  '192.168.0.0/16', // RFC1918 private
  '198.18.0.0/15', // RFC2544 benchmarking
  '198.51.100.0/24', // TEST-NET-2 documentation
  '203.0.113.0/24', // TEST-NET-3 documentation
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved (incl. 255.255.255.255 broadcast)
].map(ipv4Cidr);

function ipv6ToBigInt(ip: string): bigint {
  // Expand :: shorthand into eight 16-bit groups.
  const [head, tail] = ip.split('::');
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail !== undefined ? (tail ? tail.split(':').filter(Boolean) : []) : null;

  let groups: string[];
  if (tailGroups === null) {
    groups = ip.split(':');
  } else {
    const missing = 8 - headGroups.length - tailGroups.length;
    groups = [...headGroups, ...Array(Math.max(missing, 0)).fill('0'), ...tailGroups];
  }

  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) + BigInt(parseInt(group || '0', 16));
  }
  return value;
}

function ipv6Cidr(cidr: string): CidrRange {
  const [addr, bitsRaw] = cidr.split('/');
  const bits = BigInt(bitsRaw);
  const start = ipv6ToBigInt(addr);
  const size = 1n << (128n - bits);
  return { cidr, start, size };
}

// Unspecified, loopback, ULA, link-local, multicast, documentation, discard, NAT64.
const PRIVATE_V6_RANGES: CidrRange[] = [
  '::/128', // unspecified
  '::1/128', // IPv6 loopback
  '::ffff:0:0/96', // IPv4-mapped (re-checked against the IPv4 ranges below)
  '64:ff9b::/96', // NAT64 (maps IPv4 space)
  '100::/64', // discard-only
  '2001:db8::/32', // documentation
  'fc00::/7', // unique local addresses
  'fe80::/10', // link-local
  'ff00::/8', // multicast
].map(ipv6Cidr);

function isPrivateIPv4(ip: string): boolean {
  const value = ipv4ToBigInt(ip);
  return PRIVATE_V4_RANGES.some((range) => value >= range.start && value < range.start + range.size);
}

function isPrivateIPv6(ip: string): boolean {
  const value = ipv6ToBigInt(ip);
  if (PRIVATE_V6_RANGES.some((range) => value >= range.start && value < range.start + range.size)) {
    return true;
  }
  // IPv4-mapped addresses (::ffff:a.b.c.d) must satisfy the IPv4 rules.
  const mapped = ip.toLowerCase().startsWith('::ffff:');
  if (mapped) {
    const v4 = ip.slice('::ffff:'.length);
    if (net.isIPv4(v4)) return isPrivateIPv4(v4);
    // ::ffff:0:a.b.c.d (translated) form — treat conservatively as private.
    return true;
  }
  return false;
}

function assertPublicIpLiteral(ip: string): void {
  if (net.isIPv4(ip)) {
    if (isPrivateIPv4(ip)) {
      throw new UrlGuardError('Private or internal IP addresses are prohibited');
    }
    return;
  }
  if (net.isIPv6(ip)) {
    if (isPrivateIPv6(ip)) {
      throw new UrlGuardError('Private or internal IP addresses are prohibited');
    }
    return;
  }
  throw new UrlGuardError('Private or internal IP addresses are prohibited');
}

/** Hostnames that must never be fetched even before DNS resolution. */
function isBlockedHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname === 'metadata.google.internal' || hostname === 'instance-data';
}

/**
 * Validate an http(s) URL for outbound fetching. Resolves the hostname via DNS
 * and rejects any destination that maps to private, loopback, link-local or
 * reserved address space.
 *
 * - Throws UrlGuardError with a client-safe message when the target is prohibited.
 * - Throws UrlResolutionError when DNS resolution fails (no request is possible,
 *   so callers may degrade gracefully).
 * - Resolves with the parsed URL otherwise.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UrlGuardError('Valid http or https URL is required');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlGuardError('Valid http or https URL is required');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) {
    throw new UrlGuardError('Valid http or https URL is required');
  }

  // Literal IPs are checked directly, without DNS.
  if (net.isIPv4(hostname) || (hostname.includes(':') && net.isIPv6(hostname))) {
    assertPublicIpLiteral(hostname);
    return parsed;
  }

  if (isBlockedHostname(hostname)) {
    throw new UrlGuardError('Private or internal IP addresses are prohibited');
  }

  // Hostname: resolve and require every resolved address to be public.
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UrlResolutionError(hostname);
  }

  if (!addresses.length) {
    throw new UrlResolutionError(hostname);
  }

  for (const { address } of addresses) {
    assertPublicIpLiteral(address);
  }

  return parsed;
}
