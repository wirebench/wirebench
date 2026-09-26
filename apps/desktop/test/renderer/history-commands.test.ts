import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast, ToastViewport: () => null }));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { listCommands, resetCommands, runCommand } from '../../src/renderer/lib/commands.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useHistoryStore } from '../../src/renderer/state/history.js';
import { useWsiStore } from '../../src/renderer/state/wsi.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { HistoryEntryWire, WsiReportWire } from '../../src/shared/wire-types.js';

const context: CommandContext = {
  platform: 'mac',
  ui: {
    sidebar: { visible: true, view: 'history', size: 20, lastSize: 20 },
    console: { visible: true, activeTab: 'http-log', size: 25, lastSize: 25 },
    slideOver: { open: false, width: 420, codeShell: 'posix' },
    theme: 'dark',
    editorLineNumbers: true,
    editorLayout: { orientation: 'side-by-side', mode: 'split' },
  },
  selection: undefined,
};

function entry(overrides: Partial<HistoryEntryWire> = {}): HistoryEntryWire {
  return {
    id: 'h-1',
    at: '2026-01-01T00:00:00.000Z',
    projectId: 'proj-1',
    requestName: 'Add',
    interfaceName: 'Calc',
    operationName: 'Add',
    endpoint: 'http://dev.test/soap',
    soapVersion: '1.1',
    durationMs: 5,
    ok: true,
    status: 200,
    request: { envelopeXml: '<Request/>', headers: [] },
    sizeBytes: 10,
    ...overrides,
  };
}

const REPORT: WsiReportWire = {
  profile: 'BP1.1',
  target: 'the last send',
  label: 'the last send',
  scope: 'message',
  assertions: [],
  summary: { passed: 0, failed: 0, warning: 0, notApplicable: 0 },
};

describe('history commands', () => {
  beforeEach(() => {
    installWirebenchApi();
    resetCommands();
    registerShellCommands(vi.fn());
    useHistoryStore.setState({ entries: [], total: 0, query: '', loading: false });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    useWsiStore.setState({ status: 'idle', report: undefined, subject: undefined, error: undefined });
  });

  afterEach(() => {
    useHistoryStore.setState({ entries: [], total: 0, query: '', loading: false });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
  });

  it('offers none of them while the history is empty', () => {
    const ids = listCommands(context).map((command) => command.id);

    expect(ids).not.toContain('history.resend');
    expect(ids).not.toContain('history.compare');
    expect(ids).not.toContain('history.clear');
  });

  it('re-sends the newest entry', async () => {
    const resend = vi.fn().mockResolvedValue({ ok: true, value: { sendId: 's-1' } });
    installWirebenchApi({ history: { resend } });
    useHistoryStore.setState({ entries: [entry({ id: 'new' }), entry({ id: 'old' })], total: 2 });

    expect(await runCommand('history.resend', context)).toBe(true);

    await vi.waitFor(() => {
      expect(resend).toHaveBeenCalledWith({ id: 'new' });
    });
  });

  it('re-sends the newest SOAP entry, passing over newer entries of other kinds, and says so', async () => {
    showToast.mockReset();
    const resend = vi.fn().mockResolvedValue({ ok: true, value: { sendId: 's-1' } });
    installWirebenchApi({ history: { resend } });
    useHistoryStore.setState({
      entries: [
        entry({ id: 'ws', kind: 'websocket' }),
        entry({ id: 'rest', kind: 'rest' }),
        entry({ id: 'soap', kind: 'soap' }),
      ],
      total: 3,
    });
    await runCommand('history.resend', context);
    await vi.waitFor(() => {
      expect(resend).toHaveBeenCalledWith({ id: 'soap' });
    });
    // Nothing older may be replayed in silence: the row that is being re-sent is named.
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Re-sending the newest SOAP entry'));
  });

  it('says nothing extra when the newest entry is the one it re-sends', async () => {
    showToast.mockReset();
    const resend = vi.fn().mockResolvedValue({ ok: true, value: { sendId: 's-1' } });
    installWirebenchApi({ history: { resend } });
    useHistoryStore.setState({ entries: [entry({ id: 'soap', kind: 'soap' })], total: 1 });

    await runCommand('history.resend', context);

    await vi.waitFor(() => {
      expect(resend).toHaveBeenCalledWith({ id: 'soap' });
    });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('says there is nothing to re-send when no entry is SOAP', async () => {
    showToast.mockReset();
    const resend = vi.fn();
    installWirebenchApi({ history: { resend } });
    useHistoryStore.setState({ entries: [entry({ id: 'g', kind: 'grpc' })], total: 1 });
    await runCommand('history.resend', context);
    await vi.waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Nothing to re-send: only a SOAP entry can be re-sent from History.');
    });
    expect(resend).not.toHaveBeenCalled();
  });

  it('needs two entries before it will compare, then opens one diff tab', async () => {
    useHistoryStore.setState({ entries: [entry({ id: 'only' })], total: 1 });
    expect(listCommands(context).map((command) => command.id)).not.toContain('history.compare');

    useHistoryStore.setState({
      entries: [
        entry({ id: 'new', response: { envelopeXml: '<New/>', rawHeaders: [], status: 200, statusText: 'OK' } }),
        entry({ id: 'old', response: { envelopeXml: '<Old/>', rawHeaders: [], status: 200, statusText: 'OK' } }),
      ],
      total: 2,
    });
    expect(await runCommand('history.compare', context)).toBe(true);

    const tab = useEditorsStore.getState().tabs.find((candidate) => candidate.kind === 'diff');
    expect(tab?.diff?.leftXml).toBe('<Old/>');
    expect(tab?.diff?.rightXml).toBe('<New/>');
    expect(tab?.diff?.rest).toBeUndefined();
  });

  it('compares the two newest REST entries by their Response and Request texts', async () => {
    const rest = (id: string, status: number, statusText: string): HistoryEntryWire =>
      entry({
        id,
        kind: 'rest',
        method: 'GET',
        soapVersion: 'none',
        endpoint: `https://api.test/${id}`,
        request: { envelopeXml: '', headers: [] },
        response: { envelopeXml: '{}', rawHeaders: [], status, statusText },
      });
    useHistoryStore.setState({ entries: [rest('new', 404, 'Not Found'), rest('old', 200, 'OK')], total: 2 });

    expect(await runCommand('history.compare', context)).toBe(true);

    const texts = useEditorsStore.getState().tabs.find((candidate) => candidate.kind === 'diff')?.diff?.rest;
    expect(texts?.response.left.split('\n')[0]).toBe('200 OK');
    expect(texts?.response.right.split('\n')[0]).toBe('404 Not Found');
    expect(texts?.request.left.split('\n')[0]).toBe('GET https://api.test/old');
    expect(texts?.request.right.split('\n')[0]).toBe('GET https://api.test/new');
  });

  it('clears every entry', async () => {
    const clear = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    installWirebenchApi({ history: { clear } });
    useHistoryStore.setState({ entries: [entry()], total: 1 });

    expect(await runCommand('history.clear', context)).toBe(true);

    await vi.waitFor(() => {
      expect(useHistoryStore.getState().total).toBe(0);
    });
  });
});

describe('request.exportWsiReport', () => {
  beforeEach(() => {
    installWirebenchApi();
    resetCommands();
    registerShellCommands(vi.fn());
    useWsiStore.setState({ status: 'idle', report: undefined, subject: undefined, error: undefined });
  });

  it('is unavailable until a report has been run', () => {
    expect(listCommands(context).map((command) => command.id)).not.toContain('request.exportWsiReport');
  });

  it('exports the report the WS-I tab is holding', async () => {
    const exportHtml = vi.fn().mockResolvedValue({ ok: true, value: { cancelled: false, path: '/tmp/report.html' } });
    installWirebenchApi({ wsi: { exportHtml } });
    useWsiStore.setState({ status: 'ready', report: REPORT, showAll: false });

    expect(await runCommand('request.exportWsiReport', context)).toBe(true);

    await vi.waitFor(() => {
      expect(exportHtml).toHaveBeenCalled();
    });
  });
});
