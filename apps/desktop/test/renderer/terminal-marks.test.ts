import { beforeEach, describe, expect, it } from 'vitest';
import {
  endsInPrompt,
  forgetMark,
  nextMark,
  noteError,
  noteOutput,
  noteView,
  promptWatcher,
  useTerminalMarksStore,
  worstMark,
  type MarkView,
} from '../../src/renderer/features/ssh/terminal-marks.js';

const BEHIND: MarkView = { inFront: false, focused: false };
const BEHIND_FOCUSED: MarkView = { inFront: false, focused: true };
const FRONT_OTHER_PANE: MarkView = { inFront: true, focused: false };
const FRONT_FOCUSED: MarkView = { inFront: true, focused: true };
const OUTPUT = { kind: 'output', prompt: false } as const;
const PROMPT = { kind: 'output', prompt: true } as const;
const ERROR = { kind: 'error' } as const;

describe('nextMark', () => {
  it('output while the tab is behind another marks it unread', () => {
    expect(nextMark(undefined, OUTPUT, BEHIND)).toBe('unread');
    // The pane that has the keys in a tab behind another is still out of sight.
    expect(nextMark(undefined, OUTPUT, BEHIND_FOCUSED)).toBe('unread');
  });

  it('output on screen marks nothing, the focused pane’s or another pane’s of the tab in front', () => {
    expect(nextMark(undefined, OUTPUT, FRONT_FOCUSED)).toBeUndefined();
    expect(nextMark(undefined, OUTPUT, FRONT_OTHER_PANE)).toBeUndefined();
  });

  it('a prompt marks the terminal waiting for input, even a pane on screen without the keys', () => {
    expect(nextMark(undefined, PROMPT, BEHIND)).toBe('input');
    expect(nextMark('unread', PROMPT, BEHIND)).toBe('input');
    expect(nextMark(undefined, PROMPT, FRONT_OTHER_PANE)).toBe('input');
    expect(nextMark(undefined, PROMPT, FRONT_FOCUSED)).toBeUndefined();
  });

  it('a non-zero exit or a drop marks an error, over any milder mark', () => {
    expect(nextMark(undefined, ERROR, BEHIND)).toBe('error');
    expect(nextMark('unread', ERROR, BEHIND)).toBe('error');
    expect(nextMark('input', ERROR, FRONT_OTHER_PANE)).toBe('error');
    expect(nextMark(undefined, ERROR, FRONT_FOCUSED)).toBeUndefined();
  });

  it('a milder event never replaces a worse mark', () => {
    expect(nextMark('error', OUTPUT, BEHIND)).toBe('error');
    expect(nextMark('error', PROMPT, BEHIND)).toBe('error');
    expect(nextMark('input', OUTPUT, BEHIND)).toBe('input');
  });

  it('coming to the front clears unread; getting the keys clears everything', () => {
    expect(nextMark('unread', { kind: 'view', view: FRONT_OTHER_PANE }, BEHIND)).toBeUndefined();
    expect(nextMark('input', { kind: 'view', view: FRONT_OTHER_PANE }, BEHIND)).toBe('input');
    expect(nextMark('error', { kind: 'view', view: FRONT_OTHER_PANE }, BEHIND)).toBe('error');
    for (const mark of ['unread', 'input', 'error'] as const) {
      expect(nextMark(mark, { kind: 'view', view: FRONT_FOCUSED }, BEHIND)).toBeUndefined();
    }
  });

  it('a session live again turns an error into unread, and leaves other marks (S18)', () => {
    expect(nextMark('error', { kind: 'recovered' }, BEHIND)).toBe('unread');
    expect(nextMark('error', { kind: 'recovered' }, FRONT_OTHER_PANE)).toBeUndefined();
    expect(nextMark('input', { kind: 'recovered' }, BEHIND)).toBe('input');
    expect(nextMark(undefined, { kind: 'recovered' }, BEHIND)).toBeUndefined();
  });

  it('going behind another tab adds no mark of its own', () => {
    expect(nextMark(undefined, { kind: 'view', view: BEHIND }, FRONT_FOCUSED)).toBeUndefined();
  });
});

describe('worstMark', () => {
  it('a tab shows the worst of its panes’ marks', () => {
    const marks = { a: 'unread', b: 'error', c: 'input' } as const;
    expect(worstMark(marks, ['a'])).toBe('unread');
    expect(worstMark(marks, ['a', 'c'])).toBe('input');
    expect(worstMark(marks, ['a', 'b', 'c'])).toBe('error');
    expect(worstMark(marks, ['x'])).toBeUndefined();
  });
});

describe('endsInPrompt', () => {
  it.each([
    'Password: ',
    '[sudo] password for bob: ',
    "bob@web-1's password: ",
    "Enter passphrase for key '/home/bob/.ssh/id_ed25519': ",
    'Verification code: ',
    "Enter PIN for 'yubikey': ",
    'Are you sure you want to continue connecting (yes/no/[fingerprint])? ',
    'Do you want to continue? [Y/n] ',
    'Overwrite (y/n)?',
    'last login\r\n\x1b[1;31mPassword:\x1b[0m ',
  ])('a prompt: %j', (text) => {
    expect(endsInPrompt(text)).toBe(true);
  });

  it.each([
    'bob@web-1:~$ ',
    'Password changed.\r\n',
    'password: updated\r\nbob@web-1:~$ ',
    'Spin: ',
    `${'x'.repeat(200)} password: `,
    '',
  ])('not a prompt: %j', (text) => {
    expect(endsInPrompt(text)).toBe(false);
  });
});

describe('promptWatcher', () => {
  it('finds a prompt split across chunks, and a multi-byte character split across them', () => {
    const watch = promptWatcher();
    const encoder = new TextEncoder();
    expect(watch(encoder.encode('[sudo] pass'))).toBe(false);
    expect(watch(encoder.encode('word for bob: '))).toBe(true);
    const bytes = encoder.encode('\r\nüser password: ');
    expect(watch(bytes.slice(0, 3))).toBe(false);
    expect(watch(bytes.slice(3))).toBe(true);
    expect(watch(encoder.encode('\r\nbob@web-1:~$ '))).toBe(false);
  });
});

describe('the marks store', () => {
  beforeEach(() => {
    useTerminalMarksStore.setState({ marks: {}, views: {} });
  });

  it('output in a pane whose tab is behind marks it until the user looks at it', () => {
    noteView('p1', BEHIND);
    noteOutput('p1', false);
    expect(useTerminalMarksStore.getState().marks.p1).toBe('unread');
    noteOutput('p1', true);
    expect(useTerminalMarksStore.getState().marks.p1).toBe('input');
    noteView('p1', FRONT_OTHER_PANE);
    expect(useTerminalMarksStore.getState().marks.p1).toBe('input');
    noteView('p1', FRONT_FOCUSED);
    expect(useTerminalMarksStore.getState().marks.p1).toBeUndefined();
  });

  it('a pane never seen counts as out of sight', () => {
    noteError('p2');
    expect(useTerminalMarksStore.getState().marks.p2).toBe('error');
  });

  it('the focused pane of the tab in front gets no mark', () => {
    noteView('p3', FRONT_FOCUSED);
    noteOutput('p3', true);
    noteError('p3');
    expect(useTerminalMarksStore.getState().marks.p3).toBeUndefined();
  });

  it('a closed pane takes its mark and its view with it', () => {
    noteView('p4', BEHIND);
    noteOutput('p4', false);
    forgetMark('p4');
    expect(useTerminalMarksStore.getState()).toEqual({ marks: {}, views: {} });
  });

  it('output that changes nothing leaves the state as it was', () => {
    noteView('p5', BEHIND);
    noteOutput('p5', false);
    const before = useTerminalMarksStore.getState();
    noteOutput('p5', false);
    expect(useTerminalMarksStore.getState()).toBe(before);
  });
});
