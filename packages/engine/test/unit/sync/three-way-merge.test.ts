import { describe, expect, it } from 'vitest';
import { MANIFEST_PATH, mergeFiles } from '../../../src/index.js';

const files = (entries: Record<string, string>): Map<string, string> => new Map(Object.entries(entries));

describe('mergeFiles', () => {
  it('keeps the unsaved version of a file only the unsaved side changed', () => {
    const merged = mergeFiles(files({ a: '1' }), files({ a: '1' }), files({ a: '2' }));
    expect(Object.fromEntries(merged.files)).toEqual({ a: '2' });
    expect(merged).toMatchObject({ conflicts: [], dropped: [], changed: true });
  });

  it('takes the disk version of a file only disk changed', () => {
    const merged = mergeFiles(files({ a: '1' }), files({ a: 'disk' }), files({ a: '1' }));
    expect(Object.fromEntries(merged.files)).toEqual({ a: 'disk' });
    expect(merged.changed).toBe(false);
  });

  it('restores the unsaved version on top when both sides changed, and flags it', () => {
    const merged = mergeFiles(files({ a: '1' }), files({ a: 'disk' }), files({ a: 'mine' }));
    expect(merged.files.get('a')).toBe('mine');
    expect(merged.conflicts).toEqual(['a']);
  });

  it('does not flag the same change made on both sides', () => {
    const merged = mergeFiles(files({ a: '1' }), files({ a: '2' }), files({ a: '2' }));
    expect(merged).toMatchObject({ conflicts: [], changed: false });
  });

  it('drops an unsaved change to a file that was deleted on disk', () => {
    const merged = mergeFiles(files({ a: '1', b: '1' }), files({ b: '1' }), files({ a: 'mine', b: '1' }));
    expect(merged.files.has('a')).toBe(false);
    expect(merged.dropped).toEqual(['a']);
  });

  it('applies an unsaved deletion, but keeps a file that also changed on disk', () => {
    const untouched = mergeFiles(files({ a: '1' }), files({ a: '1' }), files({}));
    expect(untouched.files.has('a')).toBe(false);
    const changedOnDisk = mergeFiles(files({ a: '1' }), files({ a: 'disk' }), files({}));
    expect(changedOnDisk.files.get('a')).toBe('disk');
    expect(changedOnDisk.conflicts).toEqual(['a']);
  });

  it('keeps files added on either side', () => {
    const merged = mergeFiles(files({}), files({ fromDisk: 'd' }), files({ mine: 'u' }));
    expect(Object.fromEntries(merged.files)).toEqual({ fromDisk: 'd', mine: 'u' });
    expect(merged.conflicts).toEqual([]);
  });

  it("ignores the manifest's writtenBy line, which every save rewrites", () => {
    const manifest = (writer: string, name: string): string =>
      `formatVersion: 2\nname: ${name}\nwrittenBy: ${writer}\n`;
    const onlySaved = mergeFiles(
      files({ [MANIFEST_PATH]: manifest('wirebench (open)', 'P') }),
      files({ [MANIFEST_PATH]: manifest('wirebench (manual)', 'P') }),
      files({ [MANIFEST_PATH]: manifest('wirebench (open)', 'P') }),
    );
    expect(onlySaved).toMatchObject({ conflicts: [], changed: false });

    const renamed = mergeFiles(
      files({ [MANIFEST_PATH]: manifest('wirebench (open)', 'P') }),
      files({ [MANIFEST_PATH]: manifest('wirebench (manual)', 'P') }),
      files({ [MANIFEST_PATH]: manifest('wirebench (open)', 'Renamed') }),
    );
    expect(renamed).toMatchObject({ conflicts: [], changed: true });
    expect(renamed.files.get(MANIFEST_PATH)).toContain('name: Renamed');
  });
});
