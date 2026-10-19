import { describe, expect, it } from 'vitest';
import { keywordName, paletteFilter, paletteKeywords } from '../../src/renderer/shell/palette-filter.js';
import { COMMAND_CATALOG } from '../../src/shared/command-catalog.js';

describe('paletteKeywords', () => {
  it('names the category and the label prefix', () => {
    expect(paletteKeywords({ category: 'Explorer', label: 'REST: New Request' })).toEqual(['Explorer', 'REST']);
  });

  it('names the category once when the prefix is the category', () => {
    expect(paletteKeywords({ category: 'History', label: 'History: Clear' })).toEqual(['History']);
  });

  it('names only the category for a label with no prefix', () => {
    expect(paletteKeywords({ category: 'Editor', label: 'Close Tab' })).toEqual(['Editor']);
  });
});

describe('paletteFilter', () => {
  const score = (category: string, label: string, search: string): number =>
    paletteFilter(`${category} ${label}`, search, paletteKeywords({ category, label }));

  it('ranks a command whose group the search names above a fuzzy hit', () => {
    const rest = score('Explorer', 'REST: New Request', 'REST');
    const closeTab = score('Editor', 'Close Tab', 'REST');

    expect(rest).toBe(1);
    expect(closeTab).toBeLessThan(rest);
  });

  it('matches a category prefix whatever its case', () => {
    expect(score('History', 'History: Clear', 'hist')).toBe(1);
  });

  it('keeps fuzzy matches, below a group match', () => {
    const fuzzy = score('Editor', 'Close Tab', 'close');

    expect(fuzzy).toBeGreaterThan(0);
    expect(fuzzy).toBeLessThan(1);
  });

  it('drops a command that does not match at all', () => {
    expect(score('Editor', 'Close Tab', 'zzzz')).toBe(0);
  });
});

describe('the ssh keyword', () => {
  const entries = Object.values(COMMAND_CATALOG);
  const scoreOf = (entry: (typeof entries)[number], search: string): number =>
    paletteFilter(`${entry.category} ${entry.label}`, search, paletteKeywords(entry));

  it('belongs to every SSH-area command, and to no other', () => {
    const ssh = entries
      .filter((entry) => paletteKeywords(entry).map(keywordName).includes('ssh'))
      .map((entry) => entry.id);
    expect(ssh).toContain('view.showHosts');
    expect(ssh).toContain('view.showForwarding');
    expect(ssh).toContain('view.showSnippets');
    expect(ssh).toContain('sftp.refresh');
    expect(ssh).toContain('ssh.startForwardGroup');
    expect(ssh).toContain('ssh.newLocalTerminal');
    for (const id of ssh) {
      expect(/^(?:ssh|sftp)\./.test(id) || id.startsWith('view.show')).toBe(true);
    }
    expect(ssh).not.toContain('view.showHttpLog');
    expect(ssh).not.toContain('secrets.toggleShowSecrets');
  });

  const isSsh = (entry: (typeof entries)[number]): boolean => paletteKeywords(entry).map(keywordName).includes('ssh');

  it('ranks every SSH command above any subsequence hit for "ssh"', () => {
    const sshScores = entries.filter(isSsh).map((e) => scoreOf(e, 'ssh'));
    const others = entries.filter((entry) => !isSsh(entry)).map((e) => scoreOf(e, 'ssh'));
    expect(Math.min(...sshScores)).toBeGreaterThan(0.9);
    // "Secrets: Toggle Show Secrets" and the like still match as a subsequence, but below.
    expect(Math.max(...others)).toBeGreaterThan(0);
    expect(Math.max(...others)).toBeLessThan(1);
  });

  it('leads with Connect to Host… and New Host… (S68)', () => {
    const ranked = entries
      .filter((entry) => entry.paletteHidden !== true && isSsh(entry))
      .map((entry) => ({ id: entry.id, score: scoreOf(entry, 'ssh') }))
      .sort((a, b) => b.score - a.score);
    expect(
      ranked
        .slice(0, 2)
        .map((row) => row.id)
        .sort(),
    ).toEqual(['ssh.connectPalette', 'ssh.newHost']);
    expect(ranked[2]?.score).toBeLessThan(ranked[1]?.score ?? 0);
  });
});

describe('fuzzy ties', () => {
  const score = (label: string, search: string): number =>
    paletteFilter(`Hosts ${label}`, search, paletteKeywords({ category: 'Hosts', label }));

  it('selects New Host… for "new host", over New Host Group… (S55)', () => {
    expect(score('Hosts: New Host…', 'new host')).toBeGreaterThan(score('Hosts: New Host Group…', 'new host'));
  });

  it('still selects New Host Group… for "new host group"', () => {
    expect(score('Hosts: New Host Group…', 'new host group')).toBeGreaterThan(
      score('Hosts: New Host…', 'new host group'),
    );
  });

  it('never reorders two different fuzzy scores by length', () => {
    // "close" matches Close Tab better than a long label that merely contains the letters.
    expect(score('Close Tab', 'close')).toBeGreaterThan(score('Hosts: Connect Local Socket Ending Somewhere', 'close'));
  });
});

describe('protocol keywords (S40)', () => {
  const entries = Object.values(COMMAND_CATALOG);
  const top = (search: string): string[] => {
    const scored = entries
      .filter((entry) => entry.paletteHidden !== true)
      .map((entry) => ({
        id: entry.id,
        score: paletteFilter(`${entry.category} ${entry.label}`, search, paletteKeywords(entry)),
      }));
    const best = Math.max(...scored.map((row) => row.score));
    return scored
      .filter((row) => row.score === best)
      .map((row) => row.id)
      .sort();
  };

  it('"telnet", "serial" and "mosh" lead with New Host… and Connect to Host…', () => {
    for (const search of ['telnet', 'serial', 'mosh']) {
      expect(top(search)).toEqual(['ssh.connectPalette', 'ssh.newHost']);
    }
  });
});
