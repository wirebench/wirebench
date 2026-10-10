import { describe, expect, it } from 'vitest';
import {
  allHosts,
  blockMatches,
  concreteAliases,
  effective,
  matchPattern,
} from '../../../src/openssh-config/evaluate.js';
import { loadSshConfig } from '../../../src/openssh-config/load.js';
import { memoryIo } from './memory-io.js';

const load = (text: string) => loadSshConfig('/home/u/.ssh/config', memoryIo({ '/home/u/.ssh/config': text }));
const flat = (e: ReturnType<typeof effective>): Record<string, unknown> => ({
  ...Object.fromEntries([...e.values].map(([k, l]) => [k, l.args.join(' ')])),
  identityfile: e.identityFiles.map((l) => l.args[0]),
});

describe('patterns', () => {
  it('globs * and ? without case', () => {
    expect(matchPattern('*.prod', 'API.PROD')).toBe(true);
    expect(matchPattern('web-?', 'web-1')).toBe(true);
    expect(matchPattern('web-?', 'web-10')).toBe(false);
    expect(matchPattern('a.b', 'axb')).toBe(false);
  });
  it('a negation excludes even when a positive pattern matches', () => {
    expect(blockMatches(['*', '!bastion'], 'web')).toBe(true);
    expect(blockMatches(['*', '!bastion'], 'bastion')).toBe(false);
    expect(blockMatches(['!bastion'], 'web')).toBe(false);
  });
});

describe('concreteAliases', () => {
  it('lists named hosts once, in order, without patterns or negations', async () => {
    const doc = await load('Host a b *.x !c\nHost b d web-?\n');
    expect(concreteAliases(doc)).toEqual(['a', 'b', 'd']);
  });
});

describe('effective', () => {
  it('keeps the first value per keyword, across global and matching blocks', async () => {
    const doc = await load('Port 2200\nHost web\n  User w\nHost *\n  User all\n  Port 22\n  HostName %h.example\n');
    expect(flat(effective(doc, 'web'))).toEqual({ port: '2200', user: 'w', hostname: '%h.example', identityfile: [] });
    expect(flat(effective(doc, 'db'))).toEqual({ port: '2200', user: 'all', hostname: '%h.example', identityfile: [] });
  });
  it('lets Host * win when it comes first', async () => {
    const doc = await load('Host *\n  User all\nHost web\n  User w\n');
    expect(flat(effective(doc, 'web')).user).toBe('all');
  });
  it('skips Match blocks and accumulates IdentityFile', async () => {
    const doc = await load('Host web\n  IdentityFile ~/.ssh/a\nMatch all\n  User m\nHost *\n  IdentityFile ~/.ssh/b\n');
    expect(flat(effective(doc, 'web'))).toEqual({ identityfile: ['~/.ssh/a', '~/.ssh/b'] });
  });
});

describe('allHosts', () => {
  it('takes the global block and bare * blocks only', async () => {
    const doc = await load('Compression yes\nHost *.prod\n  User p\nHost * !bastion\n  User all\n  Port 22\n');
    expect(flat(allHosts(doc))).toEqual({ compression: 'yes', user: 'all', port: '22', identityfile: [] });
  });
});
