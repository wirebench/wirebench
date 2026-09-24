import { describe, expect, it } from 'vitest';
import { parseServerArgs, UsageError } from '../../src/args.js';

describe('parseServerArgs', () => {
  it('defaults to serve', () => {
    expect(parseServerArgs([])).toEqual({ command: 'serve' });
    expect(parseServerArgs(['serve'])).toEqual({ command: 'serve' });
  });
  it('parses migrate and its --check flag', () => {
    expect(parseServerArgs(['migrate'])).toEqual({ command: 'migrate', check: false });
    expect(parseServerArgs(['migrate', '--check'])).toEqual({ command: 'migrate', check: true });
  });
  it('parses config check, help and version', () => {
    expect(parseServerArgs(['config', 'check'])).toEqual({ command: 'config-check' });
    expect(parseServerArgs(['--help'])).toEqual({ command: 'help' });
    expect(parseServerArgs(['--version'])).toEqual({ command: 'version' });
  });
  it('rejects unknown commands and flags', () => {
    expect(() => parseServerArgs(['frobnicate'])).toThrow(UsageError);
    expect(() => parseServerArgs(['serve', '--port'])).toThrow(UsageError);
    expect(() => parseServerArgs(['serve', '--check'])).toThrow(UsageError);
    expect(() => parseServerArgs(['config'])).toThrow(UsageError);
  });
});
