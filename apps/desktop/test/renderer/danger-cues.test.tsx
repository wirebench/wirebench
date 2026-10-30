/**
 * Danger must not be told by colour alone (#803): with some colour themes danger is amber, and
 * people who cannot tell hues apart need a shape or a word. Each mark here carries one.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordingMark } from '../../src/renderer/features/ssh/recording-mark.js';
import { ScheduleStateMark } from '../../src/renderer/features/schedules/schedule-state-mark.js';
import { ConvertScriptsDiff } from '../../src/renderer/features/scripts/convert-scripts-diff.js';
import type { ScriptConversionWire } from '@wirebench/wire/wire-base';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

afterEach(() => {
  cleanup();
});

describe('the recording mark', () => {
  it('is a record glyph (a ring around a dot), not a bare dot, and says what it means', () => {
    render(<RecordingMark />);
    const mark = screen.getByRole('img', { name: /^Recording/ });
    expect(mark.dataset['testid']).toBe('recording-mark');
    expect(mark.querySelector('svg')).not.toBeNull();
    expect(mark.className).not.toContain('rounded-full');
  });
});

describe('the schedule state mark', () => {
  it('draws a failing schedule as a cross, not a dot', () => {
    render(<ScheduleStateMark state="failing" />);
    const mark = screen.getByRole('img', { name: 'Failing' });
    expect(mark.dataset['testid']).toBe('schedule-dot');
    expect(mark.dataset['state']).toBe('failing');
    expect(mark.querySelector('svg')).not.toBeNull();
  });

  it('keeps the dot for the other states', () => {
    render(<ScheduleStateMark state="ok" />);
    const mark = screen.getByRole('img', { name: 'Passing' });
    expect(mark.querySelector('svg')).toBeNull();
    expect(mark.className).toContain('rounded-full');
  });
});

function conversion(): ScriptConversionWire {
  return {
    ownerId: 'r1',
    path: ['Shop', 'Login'],
    dialect: 'postman',
    before: { pre: 'pm.x();' },
    backups: [],
    fingerprint: 'f1',
    result: {
      ok: true,
      pre: 'wb.x();',
      mapped: 1,
      todos: [],
      todoCounts: { unsupported: 0, notMapped: 0, shadowed: 0 },
      problems: {
        pre: [
          { line: 2, column: 1, endLine: 2, endColumn: 4, message: 'Cannot find name', code: 2304, severity: 'error' },
          { line: 5, column: 1, endLine: 5, endColumn: 4, message: 'Unused value', code: 6133, severity: 'warning' },
        ],
      },
    },
  };
}

describe('the conversion review problems', () => {
  it('names each line an error or a warning, with its own icon, beside the colour', () => {
    render(<ConvertScriptsDiff level={conversion()} />);
    const items = within(screen.getByTestId('convert-scripts-phase-pre')).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const [error, warning] = items as [HTMLElement, HTMLElement];
    expect(error.dataset['severity']).toBe('error');
    expect(error.textContent).toContain('Error');
    expect(error.textContent).toContain('Line 2: Cannot find name');
    expect(error.querySelector('svg')).not.toBeNull();
    expect(warning.dataset['severity']).toBe('warning');
    expect(warning.textContent).toContain('Warning');
    expect(warning.textContent).toContain('Line 5: Unused value');
    expect(warning.querySelector('svg')).not.toBeNull();
  });
});
