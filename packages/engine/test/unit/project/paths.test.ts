import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectError } from '../../../src/errors.js';
import {
  assertPathSegment,
  assertWssRelativePath,
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
    expect(slugify('. . x . .')).toBe('_x_');
    expect(slugify('.x')).toBe('_x');
    expect(slugify('x.')).toBe('x_');
  });

  it('trims the edges in linear time on a long run of dots and spaces', () => {
    // A trailing `[. ]+$` backtracks quadratically on this; the scanner must not.
    const hostile = `${'. '.repeat(100_000)}x`;
    const started = performance.now();
    expect(slugify(hostile)).toBe('_x');
    expect(performance.now() - started).toBeLessThan(400);
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

describe('assertPathSegment', () => {
  it('accepts ordinary display-derived segments, spaces included', () => {
    expect(() => assertPathSegment('Request 1')).not.toThrow();
    expect(() => assertPathSegment('CountryInfo')).not.toThrow();
  });

  it('rejects segments that could escape the project root or corrupt the layout', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', ' a', 'a ', '.a', 'a.', 'CON', 'a\u0000b']) {
      expect(() => assertPathSegment(bad)).toThrow(ProjectError);
    }
    try {
      assertPathSegment('..');
      expect.unreachable();
    } catch (e) {
      expect((e as ProjectError).code).toBe('project-path-invalid');
      expect((e as ProjectError).details).toMatchObject({ segment: '..' });
    }
  });
});

describe('assertWssRelativePath', () => {
  it('accepts a relative path rooted at wss/', () => {
    expect(() => assertWssRelativePath('wss/outgoing/prod-signature.yaml')).not.toThrow();
  });

  it('rejects anything that is not a safe relative path under wss/', () => {
    for (const bad of [
      '../outside.yaml',
      '/etc/passwd',
      'wss/../outside.yaml',
      'other/x.yaml',
      'wss',
      'C:/x.yaml',
      'wss/a/../../b.yaml',
    ]) {
      expect(() => assertWssRelativePath(bad)).toThrow(ProjectError);
    }
  });
});

describe('path helpers', () => {
  it('builds the documented layout', () => {
    // The helpers return OS paths, so the expectations are built with `join` rather than
    // hard-coded `/` separators: on Windows the same layout uses `\`.
    expect(manifestFile('/p')).toBe(join('/p', 'wirebench.yaml'));
    expect(interfaceDir('/p', 'CountryInfo')).toBe(join('/p', 'interfaces', 'CountryInfo'));
    expect(interfaceFile('/p', 'CountryInfo')).toBe(join('/p', 'interfaces', 'CountryInfo', 'interface.yaml'));
    expect(operationDir('/p', 'CountryInfo', 'ListOfCountryNamesByCode')).toBe(
      join('/p', 'interfaces', 'CountryInfo', 'operations', 'ListOfCountryNamesByCode'),
    );
    expect(requestFiles('/p', 'CountryInfo', 'Op', 'Request 1')).toEqual({
      yaml: join('/p', 'interfaces', 'CountryInfo', 'operations', 'Op', 'Request 1.request.yaml'),
      xml: join('/p', 'interfaces', 'CountryInfo', 'operations', 'Op', 'Request 1.xml'),
    });
    expect(environmentFile('/p', 'dev')).toBe(join('/p', 'environments', 'dev.yaml'));
    expect(wssFile('/p', 'outgoing', 'prod-signature')).toBe(join('/p', 'wss', 'outgoing', 'prod-signature.yaml'));
    expect(keystoresFile('/p')).toBe(join('/p', 'wss', 'keystores.yaml'));
  });
});
