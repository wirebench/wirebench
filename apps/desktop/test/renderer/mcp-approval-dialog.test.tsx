/**
 * The stdio approval dialog (#79): it opens on `mcp.approval`, shows the server, the command line
 * as main gave it, the folder and the variables' names, and answers through `app.mcpApprove` with
 * each of its three buttons. Escape cancels, and prompts that arrive together are answered in turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { McpApprovalDialog } from '../../src/renderer/features/mcp-editor/approval-dialog.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { McpApprovalPromptEvent } from '../../src/shared/kinds/mcp/wire.js';

const mcpApprove = vi.fn();
const listeners = new Map<string, (payload: unknown) => void>();

function emit(name: string, payload: unknown): void {
  act(() => {
    listeners.get(name)?.(payload);
  });
}

function prompt(overrides: Partial<McpApprovalPromptEvent> = {}): McpApprovalPromptEvent {
  return {
    promptId: 'prompt-1',
    serverName: 'Files',
    fingerprint: 'abc',
    display: 'node server.js --token ••••••',
    cwd: '/work/project',
    envNames: ['API_TOKEN', 'LOG_LEVEL'],
    ...overrides,
  };
}

beforeEach(() => {
  mcpApprove.mockReset().mockResolvedValue({ ok: true, value: {} });
  listeners.clear();
  installWirebenchApi({
    app: { mcpApprove },
    on: vi.fn((name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    }),
  });
  render(<McpApprovalDialog />);
});

afterEach(() => {
  cleanup();
});

describe('McpApprovalDialog', () => {
  it('stays closed until a prompt arrives, then shows what would run', () => {
    expect(screen.queryByTestId('mcp-approval-dialog')).toBeNull();

    emit('mcp.approval', prompt());

    expect(screen.getByTestId('mcp-approval-server').textContent).toBe('Files');
    expect(screen.getByTestId('mcp-approval-command').textContent).toBe('node server.js --token ••••••');
    expect(screen.getByTestId('mcp-approval-cwd').textContent).toBe('/work/project');
    expect([...screen.getByTestId('mcp-approval-env').querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'API_TOKEN',
      'LOG_LEVEL',
    ]);
    // The variables' names only: nothing the dialog shows carries a value.
    expect(screen.getByTestId('mcp-approval-dialog').textContent).not.toContain('=');
  });

  it('says so when the command is given no variables', () => {
    emit('mcp.approval', prompt({ envNames: [] }));
    expect(screen.getByTestId('mcp-approval-env-none')).toBeTruthy();
  });

  it.each([
    ['mcp-approval-once', 'once'],
    ['mcp-approval-always', 'always'],
    ['mcp-approval-cancel', 'cancel'],
  ])('answers %s with %s and closes', (button, answer) => {
    emit('mcp.approval', prompt());
    fireEvent.click(screen.getByTestId(button));

    expect(mcpApprove).toHaveBeenCalledTimes(1);
    expect(mcpApprove).toHaveBeenCalledWith({ promptId: 'prompt-1', answer });
    expect(screen.queryByTestId('mcp-approval-dialog')).toBeNull();
  });

  it('cancels when dismissed with Escape', () => {
    emit('mcp.approval', prompt());
    fireEvent.keyDown(screen.getByTestId('mcp-approval-dialog'), { key: 'Escape' });

    expect(mcpApprove).toHaveBeenCalledTimes(1);
    expect(mcpApprove).toHaveBeenCalledWith({ promptId: 'prompt-1', answer: 'cancel' });
  });

  it('answers prompts in the order they came, and shows a repeated prompt once', () => {
    emit('mcp.approval', prompt());
    emit('mcp.approval', prompt());
    emit('mcp.approval', prompt({ promptId: 'prompt-2', serverName: 'Search' }));

    fireEvent.click(screen.getByTestId('mcp-approval-once'));
    expect(screen.getByTestId('mcp-approval-server').textContent).toBe('Search');
    fireEvent.click(screen.getByTestId('mcp-approval-always'));

    expect(mcpApprove.mock.calls).toEqual([
      [{ promptId: 'prompt-1', answer: 'once' }],
      [{ promptId: 'prompt-2', answer: 'always' }],
    ]);
    expect(screen.queryByTestId('mcp-approval-dialog')).toBeNull();
  });
});
