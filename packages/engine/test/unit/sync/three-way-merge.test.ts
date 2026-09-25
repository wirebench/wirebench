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

describe("mergeFiles with modifyDelete: 'conflict' (sync)", () => {
  const conflict = { modifyDelete: 'conflict' } as const;

  it('mine changed, theirs deleted: a conflict that keeps mine, never a silent drop', () => {
    const merged = mergeFiles(files({ a: '1', b: '1' }), files({ b: '1' }), files({ a: 'mine', b: '1' }), conflict);
    expect(Object.fromEntries(merged.files)).toEqual({ a: 'mine', b: '1' });
    expect(merged).toMatchObject({ conflicts: ['a'], dropped: [], changed: true });
  });

  it('mine deleted, theirs changed: a conflict that keeps theirs, as without the option', () => {
    const withOption = mergeFiles(files({ a: '1' }), files({ a: 'theirs' }), files({}), conflict);
    expect(withOption.files.get('a')).toBe('theirs');
    expect(withOption).toMatchObject({ conflicts: ['a'], dropped: [] });
    expect(mergeFiles(files({ a: '1' }), files({ a: 'theirs' }), files({}))).toMatchObject({ conflicts: ['a'] });
  });

  it('a deletion of a file the other side left alone, or on both sides, is not a conflict', () => {
    // a: theirs deleted it, mine did not touch it. b: the reverse. c: both deleted it.
    const merged = mergeFiles(files({ a: '1', b: '1', c: '1' }), files({ b: '1' }), files({ a: '1' }), conflict);
    expect(Object.fromEntries(merged.files)).toEqual({});
    expect(merged).toMatchObject({ conflicts: [], dropped: [] });
  });

  it('reports both kinds of conflict together, sorted by path', () => {
    const merged = mergeFiles(
      files({ 'projects/p/b.yaml': '1', 'projects/p/a.yaml': '1', 'workspace.yaml': '1' }),
      files({ 'projects/p/a.yaml': 'theirs', 'workspace.yaml': 'theirs' }),
      files({ 'projects/p/a.yaml': 'mine', 'projects/p/b.yaml': 'mine', 'workspace.yaml': '1' }),
      conflict,
    );
    expect(merged.conflicts).toEqual(['projects/p/a.yaml', 'projects/p/b.yaml']);
    expect(Object.fromEntries(merged.files)).toEqual({
      'projects/p/a.yaml': 'mine',
      'projects/p/b.yaml': 'mine',
      'workspace.yaml': 'theirs',
    });
  });

  it('is whole-file whatever the encoding: base64 changed differently is a conflict, the same change is not', () => {
    const logo = 'projects/p/attachments/logo.png';
    const base = files({ [logo]: 'base64:iVBORw0KGgo=' });
    const differently = mergeFiles(
      base,
      files({ [logo]: 'base64:iVBORw0KGgp=' }),
      files({ [logo]: 'base64:iVBORw0KGgq=' }),
      conflict,
    );
    expect(differently.conflicts).toEqual([logo]);
    expect(differently.files.get(logo)).toBe('base64:iVBORw0KGgq=');
    const alike = mergeFiles(base, files({ [logo]: 'base64:AAAA' }), files({ [logo]: 'base64:AAAA' }), conflict);
    expect(alike).toMatchObject({ conflicts: [], changed: false });
  });

  it("'drop' is the default: no option and { modifyDelete: 'drop' } agree", () => {
    const baseline = files({ a: '1' });
    const disk = files({});
    const unsaved = files({ a: 'mine' });
    expect(mergeFiles(baseline, disk, unsaved)).toEqual(mergeFiles(baseline, disk, unsaved, { modifyDelete: 'drop' }));
    expect(mergeFiles(baseline, disk, unsaved)).toMatchObject({ conflicts: [], dropped: ['a'] });
  });
});
