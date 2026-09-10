import { describe, expect, it } from 'vitest';
import {
  environmentFile,
  interfaceDir,
  interfaceFile,
  keystoresFile,
  manifestFile,
  operationDir,
  requestFiles,
  slugify,
  uniqueSlug,
  wssFile,
} from '../../../src/project/paths.js';

describe('slugify', () => {
  it('keeps display-name case and safe characters', () => {
    expect(slugify('CountryInfo')).toBe('CountryInfo');
    expect(slugify('Request 1')).toBe('Request 1');
  });

  it('replaces characters illegal on Windows/macOS/Linux with underscores', () => {
    expect(slugify('Orders: v2/legacy?')).toBe('Orders_ v2_legacy_');
    expect(slugify('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('strips control characters', () => {
    expect(slugify('a\u0000b\u001fc\u007f')).toBe('a_b_c_');
  });

  it('collapses whitespace runs to a single space', () => {
    expect(slugify('a \t\n b')).toBe('a b');
  });

  it('replaces leading and trailing dots and spaces', () => {
    expect(slugify('  .hidden.  ')).toBe('_hidden_');
    expect(slugify('...')).toBe('_');
  });

  it('caps the length at 80 characters', () => {
    expect(slugify('x'.repeat(200))).toHaveLength(80);
    expect(slugify(`${'x'.repeat(78)}  ..`)).toBe(`${'x'.repeat(78)}_`);
  });

  it('falls back to `unnamed` for an empty result', () => {
    expect(slugify('')).toBe('unnamed');
    expect(slugify('   ')).toBe('unnamed');
  });

  it('avoids Windows reserved device names', () => {
    expect(slugify('CON')).toBe('CON_');
    expect(slugify('lpt1')).toBe('lpt1_');
    expect(slugify('nul.txt')).toBe('nul.txt_');
    expect(slugify('CONSOLE')).toBe('CONSOLE');
  });
});

describe('uniqueSlug', () => {
  it('returns the base slug when unused', () => {
    expect(uniqueSlug('Request 1', new Set())).toBe('Request 1');
  });

  it('appends a numeric suffix on collision, case-insensitively', () => {
    expect(uniqueSlug('Request 1', new Set(['Request 1', 'request 1-2']))).toBe('Request 1-3');
  });

  it('slugifies before checking for collisions', () => {
    expect(uniqueSlug('Orders: v2', new Set(['orders_ v2']))).toBe('Orders_ v2-2');
  });
});

describe('path helpers', () => {
  it('builds the documented layout', () => {
    expect(manifestFile('/p')).toBe('/p/wirebench.yaml');
    expect(interfaceDir('/p', 'CountryInfo')).toBe('/p/interfaces/CountryInfo');
    expect(interfaceFile('/p', 'CountryInfo')).toBe('/p/interfaces/CountryInfo/interface.yaml');
    expect(operationDir('/p', 'CountryInfo', 'ListOfCountryNamesByCode')).toBe(
      '/p/interfaces/CountryInfo/operations/ListOfCountryNamesByCode',
    );
    expect(requestFiles('/p', 'CountryInfo', 'Op', 'Request 1')).toEqual({
      yaml: '/p/interfaces/CountryInfo/operations/Op/Request 1.request.yaml',
      xml: '/p/interfaces/CountryInfo/operations/Op/Request 1.xml',
    });
    expect(environmentFile('/p', 'dev')).toBe('/p/environments/dev.yaml');
    expect(wssFile('/p', 'outgoing', 'prod-signature')).toBe('/p/wss/outgoing/prod-signature.yaml');
    expect(keystoresFile('/p')).toBe('/p/wss/keystores.yaml');
  });
});
