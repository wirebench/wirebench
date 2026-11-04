/**
 * The DNS check (hosted edition spec §23.2), against a fake `DnsLookup`: no test asks real DNS, and every name is
 * under `.test`.
 */
import { describe, expect, it } from 'vitest';
import { systemLookup, verifyRecords, type DnsLookup } from '../../../src/custom-domains/dns.js';

const APP = 'app.test';
const NAME = 'app.customer.test';
const TOKEN = 'tok3n-AbC_123';
const TXT_NAME = '_wirebench.app.customer.test';
const VALUE = `wirebench-domain-verification=${TOKEN}`;

/** A DNS error as `node:dns` throws it. */
function dnsError(code: string): Error {
  return Object.assign(new Error(`query ${code}`), { code });
}

type Answers = Partial<Record<'cname' | 'a' | 'aaaa' | 'txt', Record<string, unknown>>>;

/** A lookup that answers from `answers`, by kind and name; an `Error` there is thrown, a missing name is ENOTFOUND. */
function fake(answers: Answers): DnsLookup & { readonly asked: string[] } {
  const asked: string[] = [];
  const answer = (kind: keyof Answers) => (name: string) => {
    asked.push(`${kind} ${name}`);
    const value = answers[kind]?.[name];
    if (value instanceof Error) return Promise.reject(value);
    if (value === undefined) return Promise.reject(dnsError('ENOTFOUND'));
    return Promise.resolve(value as never);
  };
  return { asked, cname: answer('cname'), a: answer('a'), aaaa: answer('aaaa'), txt: answer('txt') };
}

const GOOD_TXT = { [TXT_NAME]: [[VALUE]] };

describe('verifyRecords', () => {
  it('passes a CNAME to custom.<app-domain> and the TXT token', async () => {
    const result = await verifyRecords(
      fake({ cname: { [NAME]: ['custom.app.test'] }, txt: GOOD_TXT }),
      NAME,
      TOKEN,
      APP,
    );
    expect(result).toMatchObject({ cname: 'ok', txt: 'ok' });
    expect(result.message).not.toBe('');
  });

  it('compares the CNAME lower-case and without its trailing dot', async () => {
    for (const target of ['CUSTOM.App.Test.', 'custom.app.test.', 'Custom.app.test']) {
      const result = await verifyRecords(fake({ cname: { [NAME]: [target] }, txt: GOOD_TXT }), NAME, TOKEN, APP);
      expect(result.cname, target).toBe('ok');
    }
  });

  it('reads a CNAME to anything else as wrong, and says where it points', async () => {
    const result = await verifyRecords(
      fake({ cname: { [NAME]: ['customer.hosting.test'] }, txt: GOOD_TXT }),
      NAME,
      TOKEN,
      APP,
    );
    expect(result.cname).toBe('wrong');
    expect(result.message).toContain('customer.hosting.test');
    expect(result.message).toContain('custom.app.test');
  });

  it('passes a flattened name whose A and AAAA answers equal the target’s', async () => {
    const lookup = fake({
      cname: { [NAME]: dnsError('ENODATA') },
      a: { [NAME]: ['192.0.2.2', '192.0.2.1'], 'custom.app.test': ['192.0.2.1', '192.0.2.2'] },
      aaaa: { [NAME]: ['2001:db8::1'], 'custom.app.test': ['2001:DB8::1'] },
      txt: GOOD_TXT,
    });
    expect((await verifyRecords(lookup, NAME, TOKEN, APP)).cname).toBe('ok');
  });

  it('reads a flattened name with other addresses as wrong', async () => {
    const lookup = fake({
      cname: { [NAME]: dnsError('ENODATA') },
      a: { [NAME]: ['198.51.100.7'], 'custom.app.test': ['192.0.2.1'] },
      aaaa: { [NAME]: dnsError('ENODATA'), 'custom.app.test': dnsError('ENODATA') },
      txt: GOOD_TXT,
    });
    expect((await verifyRecords(lookup, NAME, TOKEN, APP)).cname).toBe('wrong');
  });

  it('never passes on empty addresses, even when both sides are empty', async () => {
    const lookup = fake({
      cname: { [NAME]: dnsError('ENODATA') },
      a: { [NAME]: dnsError('ENODATA'), 'custom.app.test': dnsError('ENODATA') },
      aaaa: { [NAME]: dnsError('ENODATA'), 'custom.app.test': dnsError('ENODATA') },
      txt: GOOD_TXT,
    });
    expect((await verifyRecords(lookup, NAME, TOKEN, APP)).cname).toBe('missing');
    // The name's A matches but its AAAA is empty while the target has one: not equal.
    const half = fake({
      cname: { [NAME]: dnsError('ENODATA') },
      a: { [NAME]: ['192.0.2.1'], 'custom.app.test': ['192.0.2.1'] },
      aaaa: { [NAME]: dnsError('ENODATA'), 'custom.app.test': ['2001:db8::1'] },
      txt: GOOD_TXT,
    });
    expect((await verifyRecords(half, NAME, TOKEN, APP)).cname).toBe('wrong');
  });

  it('finds the token among other TXT strings at the name', async () => {
    const lookup = fake({
      cname: { [NAME]: ['custom.app.test'] },
      txt: { [TXT_NAME]: [['v=spf1 -all'], [VALUE], ['wirebench-domain-verification=someone-else']] },
    });
    expect((await verifyRecords(lookup, NAME, TOKEN, APP)).txt).toBe('ok');
  });

  it('joins a TXT record split into chunks', async () => {
    const lookup = fake({
      cname: { [NAME]: ['custom.app.test'] },
      txt: { [TXT_NAME]: [['wirebench-domain-', 'verification=', TOKEN]] },
    });
    expect((await verifyRecords(lookup, NAME, TOKEN, APP)).txt).toBe('ok');
  });

  it('reads another token, or a value with more around it, as wrong, and never repeats a token', async () => {
    for (const value of [
      'wirebench-domain-verification=another',
      `${VALUE} `,
      ` ${VALUE}`,
      `wirebench-domain-verification=${TOKEN.toLowerCase()}`,
    ]) {
      const result = await verifyRecords(
        fake({ cname: { [NAME]: ['custom.app.test'] }, txt: { [TXT_NAME]: [[value]] } }),
        NAME,
        TOKEN,
        APP,
      );
      expect(result.txt, value).toBe('wrong');
      expect(result.message).not.toContain(TOKEN);
      expect(result.message).not.toContain('another');
    }
  });

  it('reads ENOTFOUND and ENODATA as missing', async () => {
    for (const code of ['ENOTFOUND', 'ENODATA']) {
      const result = await verifyRecords(
        fake({
          cname: { [NAME]: dnsError(code) },
          a: { [NAME]: dnsError(code), 'custom.app.test': ['192.0.2.1'] },
          aaaa: { [NAME]: dnsError(code), 'custom.app.test': dnsError('ENODATA') },
          txt: { [TXT_NAME]: dnsError(code) },
        }),
        NAME,
        TOKEN,
        APP,
      );
      expect(result, code).toMatchObject({ cname: 'missing', txt: 'missing' });
      expect(result.message).not.toBe('');
    }
  });

  it('turns a timeout or a server failure into a message, never a throw', async () => {
    const result = await verifyRecords(
      fake({
        cname: { [NAME]: dnsError('ETIMEOUT') },
        a: { [NAME]: dnsError('ETIMEOUT'), 'custom.app.test': dnsError('ETIMEOUT') },
        aaaa: { [NAME]: dnsError('ETIMEOUT'), 'custom.app.test': dnsError('ETIMEOUT') },
        txt: { [TXT_NAME]: dnsError('ESERVFAIL') },
      }),
      NAME,
      TOKEN,
      APP,
    );
    expect(result.cname).toBe('missing');
    expect(result.txt).toBe('missing');
    expect(result.message).toMatch(/timed out/);
    expect(result.message).toMatch(/failed/);
    // Even a lookup that throws something odd.
    const odd: DnsLookup = {
      cname: () => Promise.reject(new TypeError('boom')),
      a: () => Promise.reject(new TypeError('boom')),
      aaaa: () => Promise.reject(new TypeError('boom')),
      txt: () => Promise.reject(new TypeError('boom')),
    };
    await expect(verifyRecords(odd, NAME, TOKEN, APP)).resolves.toMatchObject({ cname: 'missing', txt: 'missing' });
  });

  it('asks only the name, the TXT name and, when flattening is checked, the target', async () => {
    const lookup = fake({ cname: { [NAME]: ['custom.app.test'] }, txt: GOOD_TXT });
    await verifyRecords(lookup, NAME, TOKEN, APP);
    expect(lookup.asked.sort()).toEqual([`cname ${NAME}`, `txt ${TXT_NAME}`]);
  });
});

describe('systemLookup', () => {
  it('takes IP servers, with or without a port, and refuses a host name', () => {
    expect(() => systemLookup(['192.0.2.53', '192.0.2.54:5353', '[2001:db8::53]:53', '2001:db8::54'])).not.toThrow();
    expect(() => systemLookup(['dns.test'])).toThrow();
  });

  it('builds with the system servers when given none', () => {
    const lookup = systemLookup();
    expect(typeof lookup.cname).toBe('function');
    expect(typeof lookup.txt).toBe('function');
  });
});
