/**
 * The command line of slice 7 Tasks 21 and 22 (hosted edition spec §22.9, §22.10, §22.14): `admin audit verify
 * --export <file>`, `admin tenant export [<slug>] --out <file>` and `admin tenant import <file> […]`, and the options
 * each refuses elsewhere.
 */
import { describe, expect, it } from 'vitest';
import { parseServerArgs } from '../../../src/args.js';

const parse = (line: string) => parseServerArgs(line.split(' '));

describe('the export and import arguments (spec §22.14)', () => {
  it('parses admin audit verify --export, which names no tenant', () => {
    expect(parse('admin audit verify --export team.tar.gz --json')).toEqual({
      command: 'admin-audit-verify-export',
      file: 'team.tar.gz',
      json: true,
    });
    expect(() => parse('admin audit verify --export team.tar.gz --tenant acme')).toThrow(/--tenant/);
    expect(() => parse('admin audit export --export team.tar.gz')).toThrow(/--export applies to admin audit verify/);
  });

  it('parses admin tenant export, with or without a slug, and needs --out', () => {
    expect(parse('admin tenant export --out team.tar.gz')).toEqual({
      command: 'admin-tenant-export',
      out: 'team.tar.gz',
    });
    expect(parse('admin tenant export acme --out team.tar.gz')).toEqual({
      command: 'admin-tenant-export',
      slug: 'acme',
      out: 'team.tar.gz',
    });
    expect(() => parse('admin tenant export acme')).toThrow(/--out/);
    expect(() => parse('admin tenant list --out x')).toThrow(/--out applies to admin tenant export only/);
  });

  it('parses admin tenant import with its options', () => {
    expect(parse('admin tenant import team.tar.gz')).toEqual({ command: 'admin-tenant-import', file: 'team.tar.gz' });
    expect(parse('admin tenant import team.tar.gz --slug moved --name Moved --edition enterprise --seats 9')).toEqual({
      command: 'admin-tenant-import',
      file: 'team.tar.gz',
      slug: 'moved',
      name: 'Moved',
      edition: 'enterprise',
      seats: 9,
    });
    expect(() => parse('admin tenant import')).toThrow();
    expect(() => parse('admin tenant import team.tar.gz --email a@b.test')).toThrow(
      /--email applies to admin tenant create/,
    );
    expect(() => parse('admin tenant import team.tar.gz --edition community')).toThrow(/team or enterprise/);
  });
});
