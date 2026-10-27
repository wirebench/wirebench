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
    ]),
  ],
];

/** `::ffff:a.b.c.d` (or its hex spelling `::ffff:7f00:1`) as the IPv4 address it carries; anything else unchanged. */
function unwrapMapped(address: string): string {
  const lower = address.toLowerCase();
  if (!lower.startsWith('::ffff:')) return address;
  const rest = lower.slice('::ffff:'.length);
  if (isIP(rest) === 4) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (hex === null) return address;
  const high = Number.parseInt(hex[1]!, 16);
  const low = Number.parseInt(hex[2]!, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * The class of `address`, after unwrapping an IPv4-mapped IPv6 address and dropping a zone (`%en0`).
 * Something that is not an address at all reads as `unspecified`, so it can never pass the check.
 */
export function classifyAddress(address: string): AddressClass {
  const zoneless = address.includes('%') ? address.slice(0, address.indexOf('%')) : address;
  const unwrapped = unwrapMapped(zoneless);
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
