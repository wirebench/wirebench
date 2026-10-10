import { describe, expect, it } from 'vitest';
import { loadSshConfig } from '../../../src/openssh-config/load.js';
import { memoryIo } from './memory-io.js';

const MAIN = '/home/u/.ssh/config';
const summary = (doc: Awaited<ReturnType<typeof loadSshConfig>>) =>
  doc.blocks.map((b) => [b.kind, b.patterns.join(' '), b.lines.map((l) => `${l.keyword} ${l.args.join(' ')}`)]);

describe('loadSshConfig', () => {
  it('groups lines into a global block, Host blocks and Match blocks', async () => {
    const doc = await loadSshConfig(
      MAIN,
      memoryIo({ [MAIN]: 'User top\nHost a b\n  Port 1\nMatch host x\n  User m\nHost *\n  User all\n' }),
    );
    expect(summary(doc)).toEqual([
      ['global', '', ['user top']],
      ['host', 'a b', ['port 1']],
      ['match', '', ['user m']],
      ['host', '*', ['user all']],
    ]);
    expect(doc.blocks[1]?.at).toEqual({ file: '~/.ssh/config', line: 2 });
  });

  it('drops an empty global block', async () => {
    const doc = await loadSshConfig(MAIN, memoryIo({ [MAIN]: 'Host a\n  Port 1\n' }));
    expect(doc.blocks.map((b) => b.kind)).toEqual(['host']);
  });

  it('splices an Include in place, relative to ~/.ssh, with globs sorted', async () => {
    const doc = await loadSshConfig(
      MAIN,
      memoryIo({
        [MAIN]: 'Include conf.d/*\nHost z\n  Port 9\n',
        '/home/u/.ssh/conf.d/b': 'Host b\n  Port 2\n',
        '/home/u/.ssh/conf.d/a': 'Host a\n  Port 1\n',
      }),
    );
    expect(summary(doc)).toEqual([
      ['host', 'a', ['port 1']],
      ['host', 'b', ['port 2']],
      ['host', 'z', ['port 9']],
    ]);
    expect(doc.blocks[0]?.lines[0]?.file).toBe('~/.ssh/conf.d/a');
  });

  it('expands ~ and accepts absolute Include paths', async () => {
    const doc = await loadSshConfig(
      MAIN,
      memoryIo({ [MAIN]: 'Include ~/extra /etc/ssh/more\n', '/home/u/extra': 'Host e\n', '/etc/ssh/more': 'Host m\n' }),
    );
    expect(doc.blocks.map((b) => b.patterns[0])).toEqual(['e', 'm']);
  });

  it('keeps an Include inside a Host block in that block, then resumes the outer block', async () => {
    const doc = await loadSshConfig(
      MAIN,
      memoryIo({
        [MAIN]: 'Host a\n  Include part\n  Port 3\nHost c\n',
        '/home/u/.ssh/part': 'User inc\nHost b\n  Port 2\n',
      }),
    );
    expect(summary(doc)).toEqual([
      ['host', 'a', ['user inc']],
      ['host', 'b', ['port 2']],
      ['host', 'a', ['port 3']],
      ['host', 'c', []],
    ]);
  });

  it('notes a missing target and an empty glob; reports an unreadable one with its errno', async () => {
    const doc = await loadSshConfig(
      MAIN,
      memoryIo({
        [MAIN]: 'Include gone\nInclude none.d/*\nInclude locked\nHost a\n',
        '/home/u/.ssh/locked': Object.assign(new Error('no'), { code: 'EACCES' }),
      }),
    );
    expect(doc.notes).toEqual([
      'Include ~/.ssh/gone (~/.ssh/config:1) does not exist',
      'Include none.d/* (~/.ssh/config:2) matched no file',
    ]);
    expect(doc.problems).toEqual([{ file: '~/.ssh/locked', why: 'could not be read (EACCES)' }]);
  });

  it('does not follow an Include inside an included file', async () => {
    const io = memoryIo({
      [MAIN]: 'Include one\n',
      '/home/u/.ssh/one': 'Include two\nHost a\n',
      '/home/u/.ssh/two': 'Host b\n',
    });
    const doc = await loadSshConfig(MAIN, io);
    expect(doc.blocks.map((b) => b.patterns[0])).toEqual(['a']);
    expect(doc.problems).toEqual([
      { file: '~/.ssh/one', line: 1, why: 'Include nested more than one level: not followed' },
    ]);
    expect(io.reads).not.toContain('/home/u/.ssh/two');
  });

  it('lets the main file read error propagate', async () => {
    await expect(loadSshConfig(MAIN, memoryIo({}))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('shows a path outside the home directory as it is', async () => {
    const doc = await loadSshConfig('/srv/cfg', memoryIo({ '/srv/cfg': 'Host a\n' }));
    expect(doc.blocks[0]?.at.file).toBe('/srv/cfg');
  });
});
