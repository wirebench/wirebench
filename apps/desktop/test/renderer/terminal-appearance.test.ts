import { describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
  applyAppearance,
  clampFontSize,
  effectiveSchemeId,
  nextZoom,
  terminalAppearance,
  terminalFontFamily,
  themeFromScheme,
  zoomChord,
  type TerminalLookPreferences,
} from '../../src/renderer/features/ssh/terminal-appearance.js';
import { schemeById, schemeLabel, TERMINAL_SCHEMES } from '../../src/renderer/features/ssh/terminal-schemes.js';

const PREFS: TerminalLookPreferences = { fontFamily: '', fontSize: 13, lineHeight: 1, colorScheme: 'app' };

const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', init);

describe('terminal schemes', () => {
  it('every scheme has a unique id, a label and 16 #rrggbb ANSI colours', () => {
    const ids = TERMINAL_SCHEMES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('app');
    for (const scheme of TERMINAL_SCHEMES) {
      expect(scheme.label).not.toBe('');
      expect(scheme.ansi).toHaveLength(16);
      for (const colour of [scheme.background, scheme.foreground, scheme.cursor, scheme.selection, ...scheme.ansi]) {
        expect(colour).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('ships the tints that tell production from staging', () => {
    expect(['red', 'amber', 'green'].map((id) => schemeById(id)?.label)).toEqual([
      'Red background',
      'Amber background',
      'Green background',
    ]);
  });

  it('labels the app scheme, and an unknown id as itself', () => {
    expect(schemeLabel('app')).toBe('Follow app theme');
    expect(schemeLabel('dracula')).toBe('Dracula');
    expect(schemeLabel('from-the-future')).toBe('from-the-future');
  });

  it('maps a palette onto xterm’s theme keys, normal colours then bright', () => {
    const nord = schemeById('nord');
    if (nord === undefined) throw new Error('nord missing');
    const theme = themeFromScheme(nord);
    expect(theme.background).toBe('#2e3440');
    expect(theme.foreground).toBe('#d8dee9');
    expect(theme.cursorAccent).toBe('#2e3440');
    expect(theme.selectionBackground).toBe('#434c5e');
    expect(theme.black).toBe('#3b4252');
    expect(theme.white).toBe('#e5e9f0');
    expect(theme.brightBlack).toBe('#4c566a');
    expect(theme.brightWhite).toBe('#eceff4');
  });
});

describe('the scheme a terminal shows', () => {
  it('the host’s, over the preferences', () => {
    expect(effectiveSchemeId({ ...PREFS, colorScheme: 'nord' }, { scheme: 'red' })).toBe('red');
    expect(effectiveSchemeId({ ...PREFS, colorScheme: 'nord' }, {})).toBe('nord');
    expect(effectiveSchemeId(PREFS)).toBe('app');
  });

  it('passes over an id this version does not know', () => {
    expect(effectiveSchemeId({ ...PREFS, colorScheme: 'nord' }, { scheme: 'from-the-future' })).toBe('nord');
    expect(effectiveSchemeId({ ...PREFS, colorScheme: 'gone' }, { scheme: 'also-gone' })).toBe('app');
  });

  it('a palette scheme draws its own colours; app draws the app’s', () => {
    expect(terminalAppearance(PREFS, { scheme: 'dracula' }).theme.background).toBe('#282a36');
    expect(terminalAppearance(PREFS).theme.background).not.toBe('#282a36');
  });
});

describe('font and size', () => {
  it('puts the chosen family before the app’s mono stack; none is the stack alone', () => {
    expect(terminalFontFamily('')).not.toContain('"');
    expect(terminalFontFamily('Fira Code')).toMatch(/^"Fira Code", /);
    expect(terminalFontFamily('Bad"Name')).toMatch(/^"BadName", /);
  });

  it('takes the host’s size over the preferences’, then the zoom on top, kept in range', () => {
    expect(terminalAppearance(PREFS).fontSize).toBe(13);
    expect(terminalAppearance({ ...PREFS, fontSize: 15 }).fontSize).toBe(15);
    expect(terminalAppearance({ ...PREFS, fontSize: 15 }, { fontSize: 18 }).fontSize).toBe(18);
    expect(terminalAppearance(PREFS, { fontSize: 18 }, 2).fontSize).toBe(20);
    expect(terminalAppearance(PREFS, undefined, -40).fontSize).toBe(6);
    expect(clampFontSize(500)).toBe(72);
  });

  it('carries the line height', () => {
    expect(terminalAppearance({ ...PREFS, lineHeight: 1.4 }).lineHeight).toBe(1.4);
  });
});

describe('applyAppearance', () => {
  it('sets the options and says whether the cell size changed', () => {
    const term = { options: {} } as unknown as Terminal;
    expect(applyAppearance(term, terminalAppearance(PREFS, { scheme: 'nord' }))).toBe(true);
    expect(term.options.fontSize).toBe(13);
    expect(term.options.theme?.background).toBe('#2e3440');
    expect(applyAppearance(term, terminalAppearance(PREFS, { scheme: 'dracula' }))).toBe(false);
    expect(term.options.theme?.background).toBe('#282a36');
    expect(applyAppearance(term, terminalAppearance(PREFS, undefined, 1))).toBe(true);
  });
});

describe('zoomChord', () => {
  it('reads ⌘+ / ⌘= / ⌘− / ⌘0 on a Mac', () => {
    expect(zoomChord(key({ key: '=', metaKey: true }), 'mac')).toBe('in');
    expect(zoomChord(key({ key: '+', metaKey: true, shiftKey: true }), 'mac')).toBe('in');
    expect(zoomChord(key({ key: '-', metaKey: true }), 'mac')).toBe('out');
    expect(zoomChord(key({ key: '0', metaKey: true }), 'mac')).toBe('reset');
  });

  it('reads Ctrl elsewhere, and leaves other chords alone', () => {
    expect(zoomChord(key({ key: '=', ctrlKey: true }), 'win')).toBe('in');
    expect(zoomChord(key({ key: '=', ctrlKey: true }), 'mac')).toBeUndefined();
    expect(zoomChord(key({ key: '-' }), 'mac')).toBeUndefined();
    expect(zoomChord(key({ key: '0', metaKey: true, altKey: true }), 'mac')).toBeUndefined();
    expect(zoomChord(key({ key: 'k', metaKey: true }), 'mac')).toBeUndefined();
  });
});

describe('nextZoom', () => {
  it('steps a point at a time and resets to none', () => {
    expect(nextZoom(13, 0, 'in')).toBe(1);
    expect(nextZoom(13, 1, 'out')).toBe(0);
    expect(nextZoom(13, 4, 'reset')).toBe(0);
  });

  it('stops at the size limits, so the way back is one step', () => {
    expect(nextZoom(72, 0, 'in')).toBe(0);
    expect(nextZoom(7, -1, 'out')).toBe(-1);
    expect(nextZoom(7, -1, 'in')).toBe(0);
  });
});
