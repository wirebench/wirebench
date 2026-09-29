/**
 * The Scripts tab (#63): the off banner and its **Switch on**, a script's text written through
 * after a pause (and removed when emptied), the secrets list checked before it is written, and the
 * checker's errors shown on the editor.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountedModelUris } from '../mocks/monaco-editor-react.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { RequestScriptsWire } from '../../src/shared/wire-types.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const { ScriptsTab, hasScripts, parseSecretNames } = await import('../../src/renderer/features/scripts/scripts-tab.js');
const { useProjectStore } = await import('../../src/renderer/state/project.js');
const { flushScriptEdits, hasScriptEditors } = await import('../../src/renderer/state/script-edits.js');

const updateRequestScripts = vi.fn();
const diagnostics = vi.fn();

const OFF: RequestScriptsWire = {
  pre: 'pm.variables.set("a", "1");',
  api: 'postman',
  enabled: false,
  secrets: [],
};

beforeEach(() => {
  updateRequestScripts.mockReset().mockResolvedValue(undefined);
  diagnostics.mockReset().mockResolvedValue({ ok: true, value: { diagnostics: [] } });
  installWirebenchApi({ script: { diagnostics } });
  useProjectStore.setState({ updateRequestScripts });
  mountedModelUris.length = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ScriptsTab', () => {
  it('shows the off banner, and Switch on writes enabled: true', () => {
    render(<ScriptsTab requestId="r1" scripts={OFF} />);

    expect(screen.getByTestId('scripts-off-banner').textContent).toContain(
      'These scripts are off. Read them, then switch them on.',
    );
    fireEvent.click(screen.getByTestId('scripts-switch-on'));

    expect(updateRequestScripts).toHaveBeenCalledWith('r1', { enabled: true });
  });

  it('writes a script after a pause, and removes it when emptied', () => {
    vi.useFakeTimers();
    render(<ScriptsTab requestId="r1" scripts={undefined} />);
    const editor = screen.getByLabelText('Pre-request script');

    fireEvent.change(editor, { target: { value: 'log(1);' } });
    expect(updateRequestScripts).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(updateRequestScripts).toHaveBeenLastCalledWith('r1', { pre: 'log(1);' });

    fireEvent.change(editor, { target: { value: '' } });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(updateRequestScripts).toHaveBeenLastCalledWith('r1', { pre: null });
  });

  it('writes a pending edit at once when a send or save flushes, and waits for main to have it', async () => {
    let written: () => void = () => undefined;
    updateRequestScripts.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          written = resolve;
        }),
    );
    render(<ScriptsTab requestId="r1" scripts={undefined} />);
    expect(hasScriptEditors()).toBe(true);
    fireEvent.change(screen.getByLabelText('Pre-request script'), { target: { value: 'log(3);' } });

    let flushed = false;
    const flushing = flushScriptEdits().then(() => {
      flushed = true;
    });
    expect(updateRequestScripts).toHaveBeenCalledWith('r1', { pre: 'log(3);' });
    await Promise.resolve();
    expect(flushed).toBe(false);
    written();
    await flushing;
    expect(flushed).toBe(true);
  });

  it('writes a pending edit when the other script is opened', () => {
    vi.useFakeTimers();
    render(<ScriptsTab requestId="r1" scripts={undefined} />);

    fireEvent.change(screen.getByLabelText('Pre-request script'), { target: { value: 'log(2);' } });
    fireEvent.click(screen.getByRole('tab', { name: /Post-response/ }));

    expect(updateRequestScripts).toHaveBeenCalledWith('r1', { pre: 'log(2);' });
    expect(screen.getByLabelText('Post-response script')).toBeTruthy();
  });

  it('checks the secrets list before writing it', () => {
    render(<ScriptsTab requestId="r1" scripts={{ post: 'log(1);', api: 'wirebench', enabled: true, secrets: [] }} />);
    const field = screen.getByTestId('scripts-secrets');

    fireEvent.change(field, { target: { value: 'signing_key, not-a-name' } });
    fireEvent.blur(field);
    expect(updateRequestScripts).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: 'signing_key, api_token signing_key' } });
    fireEvent.blur(field);
    expect(updateRequestScripts).toHaveBeenCalledWith('r1', { secrets: ['signing_key', 'api_token'] });
  });

  it("shows the checker's errors under the editor", async () => {
    diagnostics.mockResolvedValue({
      ok: true,
      value: {
        diagnostics: [
          {
            line: 1,
            column: 5,
            endLine: 1,
            endColumn: 12,
            message: "Property 'statuss' does not exist",
            code: 2339,
            severity: 'error',
          },
        ],
      },
    });
    render(
      <ScriptsTab
        requestId="r1"
        scripts={{ post: 'log(response.statuss);', api: 'wirebench', enabled: true, secrets: [] }}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: /Post-response/ }));

    expect((await screen.findByTestId('script-errors')).textContent).toContain('1 error');
    expect(diagnostics).toHaveBeenCalledWith({ requestId: 'r1', phase: 'post', source: 'log(response.statuss);' });
  });
});

describe('helpers', () => {
  it('says whether a request has any script text', () => {
    expect(hasScripts(undefined)).toBe(false);
    expect(hasScripts({ api: 'wirebench', enabled: true, secrets: ['a'] })).toBe(false);
    expect(hasScripts(OFF)).toBe(true);
  });

  it('parses a secrets list', () => {
    expect(parseSecretNames(' a, b  c,,a ')).toEqual({ names: ['a', 'b', 'c'], invalid: [] });
    expect(parseSecretNames('ok 9bad x-y')).toEqual({ names: ['ok'], invalid: ['9bad', 'x-y'] });
  });
});
