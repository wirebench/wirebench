// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DialogPicks } from '../src/main/dialog-picks.js';

describe('DialogPicks', () => {
  it('keeps read and write picks as two independent sets', () => {
    const picks = new DialogPicks();
    picks.rememberRead('/attach/logo.png');
    picks.rememberWrite('/dump/out.xml');

    expect(picks.hasRead('/attach/logo.png')).toBe(true);
    expect(picks.hasWrite('/dump/out.xml')).toBe(true);

    expect(picks.hasWrite('/attach/logo.png')).toBe(false);
    expect(picks.hasRead('/dump/out.xml')).toBe(false);
  });

  it('a path picked in the attachments "Add" dialog is not a legal Dump File write target', () => {
    // This is finding 2's adversarial case: `resolveDumpPath` (main/ipc/request.ts) must not
    // treat a read pick as evidence for a write. Before the read/write split, both consulted
    // the same `has`, so a file the user merely attached could be named as a Dump File and pass.
    const picks = new DialogPicks();
    const attached = '/Users/attacker/exfil.txt';
    picks.rememberRead(attached);

    expect(picks.hasWrite(attached)).toBe(false);
  });

  it('a path picked through the Dump File "Browse…" dialog is not a legal attachment read source', () => {
    const picks = new DialogPicks();
    const dumped = '/Users/attacker/dump.xml';
    picks.rememberWrite(dumped);

    expect(picks.hasRead(dumped)).toBe(false);
  });

  it('normalises paths with resolve, independently for each side', () => {
    const picks = new DialogPicks();
    picks.rememberRead('/a/./b/../b/logo.png');
    expect(picks.hasRead('/a/b/logo.png')).toBe(true);
  });

  it("a window sees the app-wide picks, but not another window's", () => {
    const app = new DialogPicks();
    const first = new DialogPicks(app);
    const second = new DialogPicks(app);
    app.rememberRead('/etc/ca.pem');
    first.rememberRead('/tmp/attach.png');
    first.rememberWrite('/tmp/dump.xml');

    expect(first.hasRead('/etc/ca.pem')).toBe(true);
    expect(second.hasRead('/etc/ca.pem')).toBe(true);
    expect(second.hasRead('/tmp/attach.png')).toBe(false);
    expect(second.hasWrite('/tmp/dump.xml')).toBe(false);
    // A window's own pick never reaches the app set.
    expect(app.hasRead('/tmp/attach.png')).toBe(false);
  });
});
