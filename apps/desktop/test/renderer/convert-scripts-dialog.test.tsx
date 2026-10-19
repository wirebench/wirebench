/**
 * The review of a script conversion: one row per layered level, ticked unless it does not convert,
 * Accept sending only the ticked rows' fingerprints, and a toast saying what was converted and
 * what was refused, by name.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import {
  ConvertScriptsDialog,
  convertResultMessage,
  useConvertScriptsDialog,
} from '../../src/renderer/features/scripts/convert-scripts-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { ScriptConversionWire } from '../../src/shared/wire-base.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../../src/renderer/components/toast.js', async (original) => ({
  ...(await original<typeof import('../../src/renderer/components/toast.js')>()),
  showToast,
}));

const proposeConversions = vi.fn();
const convertScripts = vi.fn();

function level(ownerId: string, name: string, overrides: Partial<ScriptConversionWire> = {}): ScriptConversionWire {
  return {
    ownerId,
    path: ['Shop', name],
    dialect: 'postman',
    before: { pre: 'pm.environment.set("a", 1);' },
    result: {
      ok: true,
      pre: 'wb.environment.set("a", 1);',
      mapped: 1,
      todos: [],
      todoCounts: { unsupported: 0, notMapped: 0, shadowed: 0 },
      problems: {},
    },
    backups: [`imported-scripts/shop/shop-${name.toLowerCase()}.pre.js`],
    fingerprint: `fp-${ownerId}`,
    ...overrides,
  };
}

const LEVELS: ScriptConversionWire[] = [
  level('r1', 'Login', {
    result: {
      ok: true,
      pre: 'wb.environment.set("a", 1);\n// TODO\n',
      mapped: 1,
      todos: [],
      todoCounts: { unsupported: 1, notMapped: 2, shadowed: 0 },
      problems: {},
    },
  }),
  level('r2', 'Cart'),
  level('r3', 'Broken', { result: { ok: false, phase: 'pre', line: 3, message: 'Unexpected token' } }),
];

beforeEach(() => {
  proposeConversions.mockReset().mockResolvedValue(LEVELS);
  convertScripts.mockReset().mockResolvedValue({ applied: [], refused: [] });
  showToast.mockReset();
  installWirebenchApi();
  useProjectStore.setState({ proposeConversions, convertScripts });
});

afterEach(() => {
  cleanup();
  useConvertScriptsDialog.getState().close();
});

async function openReview(ownerId?: string): Promise<void> {
  render(<ConvertScriptsDialog />);
  await act(async () => {
    await useConvertScriptsDialog.getState().open('p1', ownerId);
  });
}

function checkbox(path: string): HTMLInputElement {
  return screen.getByRole('checkbox', { name: `Convert ${path}` });
}

describe('the review', () => {
  it('rows are ticked by default', async () => {
    await openReview('api-1');

    expect(proposeConversions).toHaveBeenCalledWith('p1', 'api-1');
    expect(checkbox('Shop / Login').checked).toBe(true);
    expect(checkbox('Shop / Cart').checked).toBe(true);
    const dialog = screen.getByTestId('convert-scripts-dialog');
    expect(dialog.textContent).toContain('2 not converted yet');
    expect(dialog.textContent).toContain('1 unsupported');
  });

  it('a syntax-error row cannot be ticked', async () => {
    await openReview();

    const broken = checkbox('Shop / Broken');
    expect(broken.checked).toBe(false);
    expect(broken.disabled).toBe(true);
    fireEvent.click(broken);
    expect(broken.checked).toBe(false);
    expect(screen.getByTestId('convert-scripts-dialog').textContent).toContain('has a syntax error at line 3');
  });

  it('shows the selected row before and after, with its problems under the diff', async () => {
    proposeConversions.mockResolvedValue([
      level('r1', 'Login', {
        result: {
          ok: true,
          pre: 'wb.environment.set("a", 1);',
          mapped: 1,
          todos: [],
          todoCounts: { unsupported: 0, notMapped: 0, shadowed: 0 },
          problems: {
            pre: [
              {
                line: 2,
                column: 1,
                endLine: 2,
                endColumn: 4,
                message: 'Cannot find name',
                code: 2304,
                severity: 'error',
              },
            ],
          },
        },
      }),
    ]);
    await openReview();

    const phase = await screen.findByTestId('convert-scripts-phase-pre');
    expect(screen.getByLabelText('Original')).toHaveProperty('value', 'pm.environment.set("a", 1);');
    expect(screen.getByLabelText('Modified')).toHaveProperty('value', 'wb.environment.set("a", 1);');
    expect(phase.textContent).toContain('Line 2: Cannot find name');
    expect(screen.queryByTestId('convert-scripts-phase-post')).toBeNull();
  });

  it('a failure with no line names its message, never line 0', async () => {
    proposeConversions.mockResolvedValue([
      level('r4', 'Odd', { result: { ok: false, phase: 'post', message: 'The script is empty' } }),
    ]);
    await openReview();

    const text = screen.getByTestId('convert-scripts-dialog').textContent;
    expect(text).toContain('The script is empty');
    expect(text).not.toContain('line 0');
  });

  it('accept sends only the ticked fingerprints', async () => {
    await openReview();

    fireEvent.click(checkbox('Shop / Cart'));
    expect(checkbox('Shop / Cart').checked).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByTestId('convert-scripts-accept'));
      await Promise.resolve();
    });

    expect(convertScripts).toHaveBeenCalledWith('p1', [{ ownerId: 'r1', fingerprint: 'fp-r1' }]);
  });

  it('refused rows are reported in a toast', async () => {
    convertScripts.mockResolvedValue({
      applied: [{ ownerId: 'r1', path: ['Shop', 'Login'], backups: ['a.pre.js', 'a.post.js'], todos: 3 }],
      refused: [
        { ownerId: 'r2', path: ['Shop', 'Cart'], reason: 'changed' },
        { ownerId: 'r5', path: ['Shop', 'Copy'], reason: 'duplicate-id' },
      ],
    });
    await openReview();

    await act(async () => {
      fireEvent.click(screen.getByTestId('convert-scripts-accept'));
      await Promise.resolve();
    });

    expect(showToast).toHaveBeenCalledTimes(1);
    const message = String(showToast.mock.calls[0]?.[0]);
    expect(message).toContain('Converted one level');
    expect(message).toContain('2 backups');
    expect(message).toContain('3 TODOs');
    expect(message).toContain('"Shop / Cart" (changed since the review opened)');
    expect(message).toContain('"Shop / Copy" (another level has the same id)');
    expect(useConvertScriptsDialog.getState().target).toBeUndefined();
  });

  it('an unsaved project keeps the review open and says to save first', async () => {
    convertScripts.mockRejectedValue(Object.assign(new Error('unsaved'), { code: 'project-dirty' }));
    await openReview();

    await act(async () => {
      fireEvent.click(screen.getByTestId('convert-scripts-accept'));
      await Promise.resolve();
    });

    expect(screen.getByRole('alert').textContent).toBe('Save the project first, then convert its scripts.');
    expect(useConvertScriptsDialog.getState().target).toBeDefined();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('says so when there is nothing to convert, and Cancel changes nothing', async () => {
    proposeConversions.mockResolvedValue([]);
    await openReview();

    expect(screen.getByTestId('convert-scripts-dialog').textContent).toContain('No imported scripts to convert here.');
    expect(screen.getByTestId('convert-scripts-accept')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByTestId('convert-scripts-cancel'));
    expect(useConvertScriptsDialog.getState().target).toBeUndefined();
    expect(convertScripts).not.toHaveBeenCalled();
  });
});

describe('the report', () => {
  it('names each refusal readably', () => {
    const message = convertResultMessage({
      applied: [],
      refused: [
        { ownerId: 'a', path: ['X'], reason: 'not-layered' },
        { ownerId: 'b', path: ['Y'], reason: 'syntax' },
        { ownerId: 'c', path: [], reason: 'changed' },
      ],
    });
    expect(message).toContain('No level was converted.');
    expect(message).toContain('"X" (already converted)');
    expect(message).toContain('"Y" (does not convert)');
    expect(message).toContain('a level no longer there (changed since the review opened)');
  });
});
