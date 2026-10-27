/**
 * The egress rule's table (hosted edition spec §17.5, ADR-0034): every range, both families, the
 * IPv4-mapped form, and the private ranges with `denyPrivate` on and off.
 */
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WirebenchError } from '#core/errors';
import { checkEgress, checkedLookup, classifyAddress, type AddressClass } from '#core/net/egress';

const TABLE: readonly (readonly [string, AddressClass])[] = [
  // loopback
  ['127.0.0.1', 'loopback'],
  ['127.255.255.254', 'loopback'],
  ['::1', 'loopback'],
  // unspecified
  ['0.0.0.0', 'unspecified'],
  ['0.255.255.255', 'unspecified'],
  ['::', 'unspecified'],
  // link-local, and the cloud metadata addresses in both families
  ['169.254.0.1', 'link-local'],
  ['169.254.255.255', 'link-local'],
  ['fe80::1', 'link-local'],
  ['febf:ffff::1', 'link-local'],
  ['169.254.169.254', 'metadata'],
  ['fd00:ec2::254', 'metadata'],
  ['100.100.100.200', 'metadata'],
  ['100.100.100.201', 'private'],
  // multicast, and the limited broadcast address with it
  ['224.0.0.1', 'multicast'],
  ['239.255.255.255', 'multicast'],
  ['255.255.255.255', 'multicast'],
  ['ff02::1', 'multicast'],
  // private
  ['10.0.0.1', 'private'],
  ['10.255.255.255', 'private'],
  ['172.16.0.1', 'private'],
  ['172.31.255.255', 'private'],
  ['192.168.0.1', 'private'],
  ['192.168.255.255', 'private'],
  ['100.64.0.1', 'private'],
  ['100.127.255.255', 'private'],
  ['fc00::1', 'private'],
  ['fdff:ffff::1', 'private'],
  // public, including the neighbours of every range
  ['8.8.8.8', 'public'],
  ['1.1.1.1', 'public'],
  ['11.0.0.1', 'public'],
  ['126.255.255.255', 'public'],
  ['128.0.0.1', 'public'],
  ['169.253.255.255', 'public'],
  ['169.255.0.1', 'public'],
  ['172.15.255.255', 'public'],
  ['172.32.0.1', 'public'],
  ['192.167.255.255', 'public'],
  ['192.169.0.1', 'public'],
  ['100.63.255.255', 'public'],
  ['100.128.0.1', 'public'],
  ['223.255.255.255', 'public'],
  ['2001:4860:4860::8888', 'public'],
  ['fec0::1', 'public'],
  ['fe00::1', 'public'],
];

describe('classifyAddress', () => {
  it.each(TABLE)('%s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it.each([
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::FFFF:169.254.169.254', 'metadata'],
    ['::ffff:a9fe:101', 'link-local'],
    ['::ffff:10.1.2.3', 'private'],
    ['::ffff:0.0.0.0', 'unspecified'],
    ['::ffff:8.8.8.8', 'public'],
  ] as const)('unwraps the IPv4-mapped %s to %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it.each([
    ['64:ff9b::a00:1', 'private'],
    ['64:ff9b::a9fe:a9fe', 'metadata'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['64:ff9b::127.0.0.1', 'loopback'],
    ['64:ff9b::a9fe:101', 'link-local'],
    ['64:ff9b::808:808', 'public'],
  ] as const)('unwraps the well-known NAT64 %s to %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it.each(['64:ff9b:1::1', '64:ff9b:1:ffff::a00:1', '64:ff9b:1::808:808'])(
    'treats local-use NAT64 %s as private',
    (address) => {
      expect(classifyAddress(address)).toBe('private');
    },
  );

  it.each([
    ['::7f00:1', 'loopback'],
    ['::127.0.0.1', 'loopback'],
    ['::a9fe:a9fe', 'metadata'],
    ['::a00:1', 'private'],
    ['::808:808', 'public'],
  ] as const)('unwraps the IPv4-compatible %s to %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it('keeps :: and ::1 in their own classes', () => {
    expect(classifyAddress('::')).toBe('unspecified');
    expect(classifyAddress('::1')).toBe('loopback');
    expect(classifyAddress('0:0:0:0:0:0:0:1')).toBe('loopback');
  });

  it.each([
    ['2002:7f00:1::1', 'loopback'],
    ['2002:a9fe:a9fe::', 'metadata'],
    ['2002:c0a8:101::1', 'private'],
    ['2002:808:808::1', 'public'],
  ] as const)('unwraps the 6to4 %s to %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it('refuses a NAT64 answer for a private address only with denyPrivate', () => {
    expect(() => checkEgress('nat64.test', '64:ff9b::a00:1', { denyPrivate: false })).not.toThrow();
    expect(() => checkEgress('nat64.test', '64:ff9b::a00:1', { denyPrivate: true })).toThrow(
      expect.objectContaining({ code: 'egress-refused' }),
    );
    expect(() => checkEgress('nat64.test', '64:ff9b::a9fe:a9fe', { denyPrivate: false })).toThrow(
      expect.objectContaining({ code: 'egress-refused' }),
    );
  });

  it('reads a scoped link-local address by its address', () => {
    expect(classifyAddress('fe80::1%en0')).toBe('link-local');
  });

  it('treats something that is not an address as unspecified, so it is never let through', () => {
    expect(classifyAddress('not-an-address')).toBe('unspecified');
  });
});

describe('checkEgress', () => {
  const ALWAYS: readonly AddressClass[] = ['loopback', 'unspecified', 'link-local', 'metadata', 'multicast'];

  it.each(TABLE)('%s (%s) follows the rule with denyPrivate off and on', (address, addressClass) => {
    for (const denyPrivate of [false, true]) {
      const refused = ALWAYS.includes(addressClass) || (addressClass === 'private' && denyPrivate);
      let thrown: unknown;
      try {
        checkEgress('target.test', address, { denyPrivate });
      } catch (err) {
        thrown = err;
      }
      if (refused) {
        expect(thrown).toMatchObject({ code: 'egress-refused' });
      } else {
        expect(thrown).toBeUndefined();
      }
    }
  });

  it('names the host and the class of address in a WirebenchError', () => {
    let thrown: unknown;
    try {
      checkEgress('metadata.test', '169.254.169.254', { denyPrivate: false });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WirebenchError);
    expect(thrown).toMatchObject({
      code: 'egress-refused',
      details: { host: 'metadata.test', addressClass: 'metadata' },
    });
    expect((thrown as Error).message).toContain('metadata.test');
  });

  it('never puts the resolved address of a private target in the message or details', () => {
    let thrown: unknown;
    try {
      checkEgress('internal.test', '10.20.30.40', { denyPrivate: true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({
      code: 'egress-refused',
      details: { host: 'internal.test', addressClass: 'private' },
    });
    expect((thrown as Error).message).not.toContain('10.20.30.40');
    expect(JSON.stringify((thrown as WirebenchError).details)).not.toContain('10.20.30.40');
  });

  it('refuses an IPv4-mapped loopback address', () => {
    expect(() => checkEgress('mapped.test', '::ffff:127.0.0.1', { denyPrivate: false })).toThrow(
      expect.objectContaining({ code: 'egress-refused' }),
    );
  });
});

/** A base lookup answering from a table, in whichever shape the caller asked for. */
function tableLookup(answers: Readonly<Record<string, readonly LookupAddress[]>>): LookupFunction {
  return (hostname, options, callback) => {
    const found = answers[hostname];
    if (found === undefined) {
      const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
      callback(err, '', 0);
      return;
    }
    if (options.all === true) {
      (callback as unknown as (err: null, addresses: LookupAddress[]) => void)(null, [...found]);
      return;
    }
    callback(null, found[0]!.address, found[0]!.family);
  };
}

function lookupAll(
  lookup: LookupFunction,
  hostname: string,
): Promise<{ err: NodeJS.ErrnoException | null; addresses: LookupAddress[] }> {
  return new Promise((resolve) => {
    lookup(hostname, { all: true }, (err, addresses) => {
      resolve({ err, addresses: Array.isArray(addresses) ? addresses : [] });
    });
  });
}

function lookupOne(
  lookup: LookupFunction,
  hostname: string,
): Promise<{ err: NodeJS.ErrnoException | null; address: string; family: number | undefined }> {
  return new Promise((resolve) => {
    lookup(hostname, {}, (err, address, family) => {
      resolve({ err, address: typeof address === 'string' ? address : '', family });
    });
  });
}

describe('checkedLookup', () => {
  const base = tableLookup({
    'public.test': [{ address: '93.184.216.34', family: 4 }],
    'mixed.test': [
      { address: '127.0.0.1', family: 4 },
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ],
    'loopback.test': [
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ],
    'private.test': [{ address: '10.0.0.7', family: 4 }],
  });

  it('passes an allowed answer through, in the shape asked for', async () => {
    const lookup = checkedLookup({ denyPrivate: true }, base);
    await expect(lookupAll(lookup, 'public.test')).resolves.toEqual({
      err: null,
      addresses: [{ address: '93.184.216.34', family: 4 }],
    });
    await expect(lookupOne(lookup, 'public.test')).resolves.toEqual({
      err: null,
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('returns only the allowed answers of a name with several', async () => {
    const lookup = checkedLookup({ denyPrivate: false }, base);
    const { err, addresses } = await lookupAll(lookup, 'mixed.test');
    expect(err).toBeNull();
    expect(addresses.map((a) => a.address)).toEqual(['93.184.216.34', '2606:2800:220:1::1']);
    const one = await lookupOne(lookup, 'mixed.test');
    expect(one.address).toBe('93.184.216.34');
  });

  it('answers egress-refused when every answer is refused', async () => {
    const lookup = checkedLookup({ denyPrivate: false }, base);
    const { err } = await lookupAll(lookup, 'loopback.test');
    expect(err).toMatchObject({ code: 'egress-refused', details: { host: 'loopback.test', addressClass: 'loopback' } });
  });

  it('refuses a private answer only with denyPrivate, without naming the address', async () => {
    await expect(lookupAll(checkedLookup({ denyPrivate: false }, base), 'private.test')).resolves.toMatchObject({
      err: null,
    });
    const { err } = await lookupOne(checkedLookup({ denyPrivate: true }, base), 'private.test');
    expect(err).toMatchObject({ code: 'egress-refused', details: { addressClass: 'private' } });
    expect(err?.message).not.toContain('10.0.0.7');
  });

  it("passes the base lookup's own failure on unchanged", async () => {
    const { err } = await lookupAll(checkedLookup({ denyPrivate: false }, base), 'nowhere.test');
    expect(err).toMatchObject({ code: 'ENOTFOUND' });
  });

  it('checks a real resolution of localhost', async () => {
    const { err } = await lookupAll(checkedLookup({ denyPrivate: false }), 'localhost');
    expect(err).toMatchObject({ code: 'egress-refused', details: { host: 'localhost', addressClass: 'loopback' } });
  });
});
