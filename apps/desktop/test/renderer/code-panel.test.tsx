import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CodePanel } from '../../src/renderer/shell/code-panel.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
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

  it('regenerates in the chosen shell', async () => {
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

  it('regenerates when the active environment changes, since it can change the endpoint and properties', async () => {
    const curl = vi.fn().mockResolvedValue({ ok: true, value: { command: COMMAND } });
    installWirebenchApi({ request: { curl } });
    openRequestTab();
    render(<CodePanel />);
    await waitFor(() => {
      expect(curl).toHaveBeenCalledTimes(1);
    });

    useWorkspaceStore.setState({
      workspace: {
        id: 'w',
        name: 'Workspace 1',
        dir: '/tmp/w',
        properties: {},
        disabled: [],
        environments: [
          { id: 'env-1', name: 'dev', slug: 'dev', order: 0, properties: {}, endpoints: {}, disabled: [] },
        ],
        activeEnvironmentId: 'env-1',
        projects: [],
      },
    });

    await waitFor(
      () => {
        expect(curl).toHaveBeenCalledTimes(2);
      },
      { timeout: 3000 },
    );
  });

  it('clears the stale command right away when switching to another request', async () => {
    let resolveSecond: ((result: { ok: true; value: { command: string } }) => void) | undefined;
    const curl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { command: COMMAND } })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    installWirebenchApi({ request: { curl } });
    useProjectStore.setState({ requests: { 'req-1': makeDraft(), 'req-2': makeDraft({ id: 'req-2' }) } });
    useEditorsStore.setState({
      tabs: [
        { id: 'request:req-1', kind: 'request', title: 'Request 1', requestId: 'req-1' },
        { id: 'request:req-2', kind: 'request', title: 'Request 2', requestId: 'req-2' },
      ],
      activeId: 'request:req-1',
    });
    render(<CodePanel />);
    await waitFor(() => {
      expect(screen.getByTestId('code-panel-preview').textContent).toBe(COMMAND);
    });
    expect(screen.getByTestId('code-panel-copy').hasAttribute('disabled')).toBe(false);

    useEditorsStore.setState({ activeId: 'request:req-2' });

    await waitFor(() => {
      expect(screen.getByTestId('code-panel-preview').textContent).toBe('');
    });
    expect(screen.getByTestId('code-panel-copy').hasAttribute('disabled')).toBe(true);

    resolveSecond?.({ ok: true, value: { command: 'curl --request POST second' } });

    await waitFor(() => {
      expect(screen.getByTestId('code-panel-preview').textContent).toBe('curl --request POST second');
    });
  });
});

/**
 * A REST request in front of the user. `request.curl` knows only SOAP requests, so the panel says
 * what it is waiting for rather than showing that channel's `unknown-request` error as a command.
 */
describe('CodePanel with a REST request', () => {
  beforeEach(() => {
    useUiStore.setState(structuredClone(DEFAULT_UI_STATE));
    useUiStore.setState({ selection: undefined });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    useProjectStore.setState({ requests: {}, restRequests: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it('says a REST cURL command is not built yet, and asks main for nothing', () => {
    const curl = vi.fn();
    installWirebenchApi({ request: { curl } });
    useEditorsStore.setState({
      tabs: [{ id: 'rest:rest-1', kind: 'rest-request', title: 'Get pet', restRequestId: 'rest-1' }],
      activeId: 'rest:rest-1',
    });

    render(<CodePanel />);

    expect(screen.getByTestId('code-panel-rest-pending')).toBeTruthy();
    expect(curl).not.toHaveBeenCalled();
  });

  it('follows a REST request selected in the explorer, with no tab open', () => {
    installWirebenchApi();
    useUiStore.setState({ selection: { kind: 'rest-request', id: 'rest:rest-1', requestId: 'rest-1' } });

    render(<CodePanel />);

    expect(screen.getByTestId('code-panel-rest-pending')).toBeTruthy();
  });

  it("still shows a SOAP request's command when one is active", async () => {
    installWirebenchApi({
      request: { curl: vi.fn().mockResolvedValue({ ok: true, value: { command: COMMAND } }) },
    });
    useProjectStore.setState({ requests: { 'req-1': makeDraft() } });
    useEditorsStore.setState({
      tabs: [{ id: 'request:req-1', kind: 'request', title: 'Request 1', requestId: 'req-1' }],
      activeId: 'request:req-1',
    });

    render(<CodePanel />);

    await waitFor(() => {
      expect(screen.getByTestId('code-panel-preview').textContent).toContain('curl');
    });
  });
});
