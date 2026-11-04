/** Custom names and their records (hosted edition spec §23.1). */
import { describe, expect, it } from 'vitest';
import { checkCustomName, CUSTOM_TARGET_LABEL, recordsFor } from '../../../src/custom-domains/names.js';
import { checkSlug } from '../../../src/tenancy/slugs.js';

const config = { appDomain: 'app.test', siteDomain: 'site.test' };
const test = { ...config, allowTest: true };

describe('checkCustomName', () => {
  it('accepts an ordinary name, lower-casing it first', () => {
    expect(checkCustomName('wirebench.example.com', config)).toEqual({ ok: true, name: 'wirebench.example.com' });
    expect(checkCustomName(' Wirebench.Example.COM ', config)).toEqual({ ok: true, name: 'wirebench.example.com' });
  });

  it.each([
    '',
    'localhostless',
    'https://wirebench.example.com',
    'wirebench.example.com:443',
    'wirebench.example.com/x',
    'wirebench.example.com.',
    '10.0.0.1',
    '-a.example.com',
    `${'a'.repeat(64)}.example.com`,
    `${'a.'.repeat(127)}com`,
  ])('refuses %j as invalid', (name) => {
    expect(checkCustomName(name, config)).toEqual({ ok: false, reason: 'custom-name-invalid' });
  });

  it('refuses a wildcard label', () => {
    expect(checkCustomName('*.example.com', config)).toEqual({ ok: false, reason: 'custom-name-invalid' });
  });

  it.each(['app.test', 'acme.app.test', 'custom.app.test', 'site.test', 'docs.site.test'])(
    'refuses %j as ours',
    (name) => {
      expect(checkCustomName(name, test)).toEqual({ ok: false, reason: 'custom-name-ours' });
    },
  );

  it.each([
    'localhost',
    'a.localhost',
    'printer.local',
    'svc.internal',
    'wirebench.customer.test',
    'x.example',
    'x.invalid',
  ])('refuses %j as local', (name) => {
    expect(checkCustomName(name, config)).toEqual({ ok: false, reason: 'custom-name-local' });
  });

  it('accepts a .test name only with the test allowance', () => {
    expect(checkCustomName('wirebench.customer.test', test)).toEqual({ ok: true, name: 'wirebench.customer.test' });
  });
});

describe('recordsFor', () => {
  it('gives the CNAME to the fixed target and the TXT token', () => {
    expect(recordsFor('wirebench.customer.test', 'tok_123', 'App.Test')).toEqual([
      { type: 'CNAME', name: 'wirebench.customer.test', value: 'custom.app.test' },
      { type: 'TXT', name: '_wirebench.wirebench.customer.test', value: 'wirebench-domain-verification=tok_123' },
    ]);
  });

  it('reserves the target label as a slug', () => {
    expect(CUSTOM_TARGET_LABEL).toBe('custom');
    expect(checkSlug('custom')).toBe('slug-reserved');
  });
});
