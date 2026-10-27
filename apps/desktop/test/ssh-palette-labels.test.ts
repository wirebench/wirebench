import { describe, expect, it } from 'vitest';
import { COMMAND_CATALOG } from '@wirebench/wire/command-catalog';

/** The SSH area's commands as the palette lists them: hidden twins left out. */
const sshEntries = Object.values(COMMAND_CATALOG).filter(
  (entry) => (entry.id.startsWith('ssh.') || entry.id.startsWith('sftp.')) && entry.paletteHidden !== true,
);

const PREFIXES = ['Hosts', 'Terminal', 'Files', 'Forwarding', 'Layouts', 'Snippets'];

describe('SSH palette labels (#536)', () => {
  it('every SSH command reads "<Area>: …" with one of the six area prefixes', () => {
    for (const entry of sshEntries) {
      const prefix = entry.label.split(': ')[0];
      expect(PREFIXES, `${entry.id}: ${entry.label}`).toContain(prefix);
    }
  });

  it('no two palette entries share a label, ignoring a trailing ellipsis', () => {
    const labels = Object.values(COMMAND_CATALOG)
      .filter((entry) => entry.paletteHidden !== true)
      .map((entry) => entry.label.replace(/…$/, ''));
    expect(labels.length).toBe(new Set(labels).size);
  });

  it('keeps only "Connect to Host…": the argument-taking twins stay off the palette', () => {
    const connects = sshEntries.filter((entry) => entry.label.includes('Connect to Host'));
    expect(connects.map((entry) => entry.label)).toEqual(['Hosts: Connect to Host…']);
    expect(COMMAND_CATALOG['ssh.connect'].paletteHidden).toBe(true);
    expect(COMMAND_CATALOG['ssh.runSnippet'].paletteHidden).toBe(true);
  });

  it('gives the forwarding commands their own category', () => {
    const forwarding = sshEntries.filter((entry) => entry.label.startsWith('Forwarding: '));
    expect(forwarding.length).toBeGreaterThan(0);
    for (const entry of forwarding) expect(entry.category).toBe('Forwarding');
  });

  it('keeps the command ids keybindings are stored under', () => {
    for (const id of [
      'ssh.connectPalette',
      'ssh.splitRight',
      'ssh.startForward',
      'ssh.openLayout',
      'sftp.focusPathBar',
    ]) {
      expect(Object.keys(COMMAND_CATALOG)).toContain(id);
    }
  });
});
