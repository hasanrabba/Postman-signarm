/**
 * SSRF guard shared by the server-side proxy.
 *
 * The rule this module enforces: a request may only leave the proxy if the
 * IP address it will actually connect to is publicly routable. Checking the
 * hostname *string* is not enough — `evil.example.com` can resolve to
 * 127.0.0.1, and a redirect can send an allowed first hop somewhere private.
 * Callers must therefore resolve the hostname and check every resolved
 * address, and re-run the check on every redirect hop.
 */

/** Strip the brackets the URL parser keeps around IPv6 literals. */
export function normalizeHostname(hostname: string): string {
  const h = hostname.trim().toLowerCase();
  const unbracketed = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  // A single trailing dot is a fully-qualified DNS name; "localhost." is the
  // same host as "localhost".
  return unbracketed.endsWith(".") ? unbracketed.slice(0, -1) : unbracketed;
}

function ipv4ToOctets(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

/** Expand an IPv6 literal (including `::` and embedded IPv4) to 8 hextets. */
function ipv6ToHextets(ip: string): number[] | null {
  let s = ip;
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone); // drop scope id
  if (!/^[0-9a-f:.]*$/.test(s) || !s.includes(":")) return null;

  // Trailing embedded IPv4, e.g. ::ffff:127.0.0.1
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const o = ipv4ToOctets(maybeV4);
    if (!o) return null;
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    s = s.slice(0, lastColon + 1) + "0:0";
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) =>
    part === "" ? [] : part.split(":").map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));

  let head: number[];
  if (halves.length === 2) {
    const left = parse(halves[0]);
    const right = parse(halves[1]);
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    head = [...left, ...Array(fill).fill(0), ...right];
  } else {
    head = parse(halves[0]);
  }
  if (tail.length) head = [...head.slice(0, 6), ...tail];
  if (head.length !== 8 || head.some((n) => Number.isNaN(n))) return null;
  return head;
}

function isBlockedIpv4(o: number[]): boolean {
  const [a, b] = o;
  if (a === 0) return true;                                  // 0.0.0.0/8
  if (a === 10) return true;                                 // private
  if (a === 100 && b >= 64 && b <= 127) return true;         // CGNAT 100.64/10
  if (a === 127) return true;                                // entire loopback /8
  if (a === 169 && b === 254) return true;                   // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;          // private
  if (a === 192 && b === 0 && o[2] === 0) return true;       // IETF protocol
  if (a === 192 && b === 168) return true;                   // private
  if (a === 198 && (b === 18 || b === 19)) return true;       // benchmark
  if (a >= 224) return true;                                 // multicast + reserved
  return false;
}

function isBlockedIpv6(h: number[]): boolean {
  if (h.every((x) => x === 0)) return true;                         // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1

  // IPv4-mapped (::ffff:a.b.c.d) / IPv4-compatible / NAT64 (64:ff9b::/96)
  const mapped =
    (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) ||
    (h.slice(0, 6).every((x) => x === 0)) ||
    (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0));
  if (mapped) {
    const v4 = [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff];
    return isBlockedIpv4(v4);
  }

  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** True when `ip` is a literal address the proxy must never connect to. */
export function isBlockedIp(ip: string): boolean {
  const host = normalizeHostname(ip);
  const v4 = ipv4ToOctets(host);
  if (v4) return isBlockedIpv4(v4);
  const v6 = ipv6ToHextets(host);
  if (v6) return isBlockedIpv6(v6);
  return false; // not a literal IP — the caller must resolve it first
}

/**
 * Hostnames rejected without a DNS lookup. Everything else has to be
 * resolved, because a name tells you nothing about where it points.
 */
export function isBlockedHostname(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "local" || h.endsWith(".local")) return true; // mDNS
  if (h.endsWith(".internal") || h.endsWith(".home.arpa")) return true;
  return isBlockedIp(h);
}
