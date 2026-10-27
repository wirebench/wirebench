/**
 * The egress rule (hosted edition spec §17.5, ADR-0034): which addresses a connection the server opens
 * on a user's or a workspace's behalf may reach.
 *
 * The check runs on the resolved address, as the socket's DNS lookup ({@link checkedLookup}), so the
 * socket connects to exactly the address that passed and nothing resolves twice. A literal address in
 * a URL never reaches a lookup, so the connectors check it with {@link checkEgress} directly.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { WirebenchError } from '../errors.js';

/** What kind of network an address belongs to; everything but `public` and `private` is always refused. */
export type AddressClass = 'loopback' | 'unspecified' | 'link-local' | 'metadata' | 'multicast' | 'private' | 'public';

/** How strict the rule is. `denyPrivate` closes the private ranges too (an operator's switch; always on hosted). */
export interface EgressPolicy {
  readonly denyPrivate: boolean;
}

type Family = 'ipv4' | 'ipv6';
type Rule = readonly [Family, string, number];

function blockList(rules: readonly Rule[]): BlockList {
  const list = new BlockList();
  for (const [family, network, prefix] of rules) list.addSubnet(network, prefix, family);
  return list;
}

/**
 * The ranges, in the order they are tried: the metadata addresses come before link-local and private,
 * which contain them, so a refusal names the more telling class.
 */
const CLASSES: readonly (readonly [AddressClass, BlockList])[] = [
  [
    'metadata',
    blockList([
      ['ipv4', '169.254.169.254', 32],
      ['ipv6', 'fd00:ec2::254', 128],
    ]),
  ],
  [
    'loopback',
    blockList([
      ['ipv4', '127.0.0.0', 8],
      ['ipv6', '::1', 128],
    ]),
  ],
  [
    'unspecified',
    blockList([
      ['ipv4', '0.0.0.0', 8],
      ['ipv6', '::', 128],
    ]),
  ],
  [
    'link-local',
    blockList([
      ['ipv4', '169.254.0.0', 16],
      ['ipv6', 'fe80::', 10],
    ]),
  ],
  [
    // The limited broadcast address sits here too: like multicast, it is never one host's.
    'multicast',
    blockList([
      ['ipv4', '224.0.0.0', 4],
      ['ipv4', '255.255.255.255', 32],
      ['ipv6', 'ff00::', 8],
    ]),
  ],
  [
    'private',
    blockList([
      ['ipv4', '10.0.0.0', 8],
      ['ipv4', '172.16.0.0', 12],
      ['ipv4', '192.168.0.0', 16],
      ['ipv4', '100.64.0.0', 10],
      ['ipv6', 'fc00::', 7],
      // Local-use NAT64 (RFC 8215): an operator's own translator, so whatever it reaches is theirs.
      ['ipv6', '64:ff9b:1::', 48],
    ]),
  ],
];

/** The eight 16-bit groups of an IPv6 address (`isIP(address) === 6`), a trailing dotted quad included. */
function hextets(address: string): number[] {
  let text = address.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted !== null) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::') as [string, string | undefined];
  const parse = (part: string): number[] => (part === '' ? [] : part.split(':').map((h) => Number.parseInt(h, 16)));
  const front = parse(head);
  if (tail === undefined) return front;
  const back = parse(tail);
  return [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back];
}

function ipv4Of(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * The IPv4 address an IPv6 one carries, where the IPv6 form only reaches that IPv4 host; anything else
 * unchanged. A check of the IPv6 form alone would let an AAAA answer reach a refused IPv4 address:
 * - `::ffff:0:0/96`, IPv4-mapped;
 * - `64:ff9b::/96`, the well-known NAT64 prefix (DNS64 on an IPv6-only subnet answers with it);
 * - `::/96`, the deprecated IPv4-compatible form, which is what URL parsing makes of `[::127.0.0.1]`
 *   (`::` and `::1` keep their own classes);
 * - `2002::/16`, 6to4, whose second and third groups are the IPv4 address.
 */
function unwrapEmbedded(address: string): string {
  if (isIP(address) !== 6) return address;
  const h = hextets(address);
  if (h.length !== 8 || h.some((group) => Number.isNaN(group))) return address;
  const zeros = (from: number, to: number): boolean => h.slice(from, to).every((group) => group === 0);
  if (zeros(0, 5) && h[5] === 0xffff) return ipv4Of(h[6]!, h[7]!);
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) return ipv4Of(h[6]!, h[7]!);
  if (zeros(0, 6) && !(h[6] === 0 && (h[7] === 0 || h[7] === 1))) return ipv4Of(h[6]!, h[7]!);
  if (h[0] === 0x2002) return ipv4Of(h[1]!, h[2]!);
  return address;
}

/**
 * The class of `address`, after unwrapping the IPv4 address an IPv6 one carries (see
 * {@link unwrapEmbedded}) and dropping a zone (`%en0`).
 * Something that is not an address at all reads as `unspecified`, so it can never pass the check.
 */
export function classifyAddress(address: string): AddressClass {
  const zoneless = address.includes('%') ? address.slice(0, address.indexOf('%')) : address;
  const unwrapped = unwrapEmbedded(zoneless);
  const version = isIP(unwrapped);
  if (version === 0) return 'unspecified';
  const family: Family = version === 4 ? 'ipv4' : 'ipv6';
  for (const [addressClass, list] of CLASSES) {
    if (list.check(unwrapped, family)) return addressClass;
  }
  return 'public';
}

const DESCRIPTIONS: Readonly<Record<Exclude<AddressClass, 'public'>, string>> = {
  loopback: 'a loopback address',
  unspecified: 'an unspecified address',
  'link-local': 'a link-local address',
  metadata: 'a cloud metadata address',
  multicast: 'a multicast or broadcast address',
  private: 'a private network address',
};

/**
 * Refuses a connection to `address` (what `host` resolved to, or `host` itself when it is a literal)
 * unless `policy` allows its class. The error names the host and the class, never the address: for a
 * private target that would turn the message into a probe of the server's network.
 *
 * @throws WirebenchError `egress-refused`, with `details: { host, addressClass }`
 */
export function checkEgress(host: string, address: string, policy: EgressPolicy): void {
  const addressClass = classifyAddress(address);
  if (addressClass === 'public') return;
  if (addressClass === 'private' && !policy.denyPrivate) return;
  throw new WirebenchError(
    'egress-refused',
    `The connection to ${host} was refused: it is ${DESCRIPTIONS[addressClass]}, which connections from here may not reach.`,
    { details: { host, addressClass } },
  );
}

type AllCallback = (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;

/**
 * A `net.LookupFunction` that resolves through `base` (the system resolver by default), checks every
 * answer, and hands the socket only the allowed ones, in whichever shape it asked for. When none is
 * allowed it answers with the first refusal. `base` is always asked for every address (`all: true`).
 */
export function checkedLookup(policy: EgressPolicy, base: LookupFunction = dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    const answer = (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]): void => {
      if (options.all === true) {
        (callback as unknown as AllCallback)(err, addresses);
        return;
      }
      const first = addresses[0];
      callback(err, first?.address ?? '', first?.family);
    };
    base(hostname, { ...options, all: true }, (err, found, family) => {
      if (err !== null) {
        answer(err, []);
        return;
      }
      const addresses: LookupAddress[] = Array.isArray(found) ? found : [{ address: found, family: family ?? 4 }];
      const allowed: LookupAddress[] = [];
      let refusal: unknown;
      for (const entry of addresses) {
        try {
          checkEgress(hostname, entry.address, policy);
          allowed.push(entry);
        } catch (refused) {
          refusal ??= refused;
        }
      }
      if (allowed.length === 0) {
        answer(
          (refusal as NodeJS.ErrnoException | undefined) ??
            Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }),
          [],
        );
        return;
      }
      answer(null, allowed);
    });
  };
}
