import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CodePanel } from '../../src/renderer/features/details/code-panel.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeDraft } from '../mocks/exchange-fixtures.js';

const COMMAND = "curl --request POST 'https://example.test/calc.asmx' --data-binary @- <<'EOF'";

function openRequestTab(): void {
  useProjectStore.setState({ requests: { 'req-1': makeDraft() } });
  useEditorsStore.setState({
    tabs: [{ id: 'request:req-1', kind: 'request', title: 'Request 1', requestId: 'req-1' }],
    activeId: 'request:req-1',
  });
}

describe('CodePanel', () => {
  beforeEach(() => {
    useUiStore.setState(structuredClone(DEFAULT_UI_STATE));
    useUiStore.setState({ selection: undefined });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    useProjectStore.setState({ requests: {} });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('asks for a request before there is one', () => {
    installWirebenchApi();
    render(<CodePanel />);

    expect(screen.getByText('Open a request to see its cURL command')).toBeDefined();
  });

  it('shows the command main generated for the active request tab', async () => {
    const curl = vi.fn().mockResolvedValue({ ok: true, value: { command: COMMAND } });
    installWirebenchApi({ request: { curl } });
    openRequestTab();
    render(<CodePanel />);

    await waitFor(() => {
      expect(screen.getByTestId('code-panel-preview').textContent).toBe(COMMAND);
    });
    expect(curl).toHaveBeenCalledWith({ requestId: 'req-1', shell: 'posix' });
  });

  it('regenerates in the chosen shell and remembers the choice', async () => {
    const curl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { command: COMMAND } })
      .mockResolvedValue({ ok: true, value: { command: 'curl.exe --request POST' } });
    installWirebenchApi({ request: { curl } });
    openRequestTab();
    render(<CodePanel />);
    await waitFor(() => {
      expect(screen.getByTestId('code-panel-preview').textContent).toBe(COMMAND);
    });

    await userEvent.selectOptions(screen.getByLabelText('Shell'), 'powershell');

    await waitFor(
      () => {
        expect(screen.getByTestId('code-panel-preview').textContent).toBe('curl.exe --request POST');
      },
      { timeout: 3000 },
    );
    expect(curl).toHaveBeenLastCalledWith({ requestId: 'req-1', shell: 'powershell' });
    expect(useUiStore.getState().details.codeShell).toBe('powershell');
  });

  it('copies the shown command', async () => {
    const curl = vi.fn().mockResolvedValue({ ok: true, value: { command: COMMAND } });
    installWirebenchApi({ request: { curl } });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    openRequestTab();
    render(<CodePanel />);
    await waitFor(() => {
      expect(screen.getByTestId('code-panel-preview').textContent).toBe(COMMAND);
    });

    await userEvent.click(screen.getByTestId('code-panel-copy'));

    expect(writeText).toHaveBeenCalledWith(COMMAND);
  });

  it('shows a failure from main in place of the command', async () => {
    const curl = vi.fn().mockResolvedValue({ ok: false, error: { code: 'no-endpoint', message: 'No endpoint' } });
    installWirebenchApi({ request: { curl } });
    openRequestTab();
    render(<CodePanel />);

    await waitFor(() => {
      expect(screen.getByTestId('code-panel-preview').textContent).toContain('No endpoint');
    });
  });

  it('notes the masking only when the command actually carries a masked value', async () => {
    const curl = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { command: `${COMMAND} -H 'Authorization: <redacted>'` } });
    installWirebenchApi({ request: { curl } });
    openRequestTab();
    render(<CodePanel />);

    await waitFor(() => {
      expect(screen.getByText('Secrets are masked unless Show secrets is on.')).toBeDefined();
    });
  });

  it('follows an explicit explorer request selection over the active tab', async () => {
    const curl = vi.fn().mockResolvedValue({ ok: true, value: { command: COMMAND } });
    installWirebenchApi({ request: { curl } });
    openRequestTab();
    useUiStore.setState({ selection: { kind: 'request', id: 'req:req-2', requestId: 'req-2' } });
    render(<CodePanel />);

    await waitFor(() => {
      expect(curl).toHaveBeenCalledWith({ requestId: 'req-2', shell: 'posix' });
    });
  });
});
