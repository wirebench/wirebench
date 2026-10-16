import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupLogged, useLogSwitchesStore } from '../../src/renderer/features/ssh/session-log-switches.js';
import {
  hideSessionLogs,
  HostSessionLogs,
  logSummary,
  SessionLogsDialog,
  showSessionLogs,
} from '../../src/renderer/features/ssh/session-logs.js';
import type { SessionLogEntryWire } from '../../src/shared/session-log-wire.js';
import type { HostsFileWire } from '../../src/shared/ssh-wire.js';

const sessionLog = {
  switches: vi.fn(),
  setSwitch: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  search: vi.fn(),
  delete: vi.fn(),
  reveal: vi.fn(),
};
vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({ sessionLog }) }));

const ok = <T,>(value: T) => ({ ok: true as const, value });

const entry = (id: string, over: Partial<SessionLogEntryWire> = {}): SessionLogEntryWire => ({
  id,
  hostId: 'web',
  hostName: 'Web',
  address: '10.0.0.1',
  port: 22,
  user: 'me',
  startedAt: '2026-10-13T18:30:00.000Z',
  endedAt: '2026-10-13T18:40:00.000Z',
  exitCode: 0,
  reason: 'exit',
  raw: false,
  bytes: 2048,
  live: false,
  ...over,
});

const groupName = (id: string): string => (id === 'prod' ? 'Production' : id);

beforeEach(() => {
  vi.clearAllMocks();
  useLogSwitchesStore.setState({ switches: {} });
  sessionLog.switches.mockResolvedValue(ok({ switches: {} }));
  sessionLog.setSwitch.mockResolvedValue(ok({}));
  sessionLog.list.mockResolvedValue(ok({ logs: [] }));
  sessionLog.read.mockResolvedValue(ok({ text: 'migrate\nERROR: x\ndone\n', truncated: false }));
  sessionLog.search.mockResolvedValue(ok({ matches: [] }));
  sessionLog.delete.mockResolvedValue(ok({}));
  sessionLog.reveal.mockResolvedValue(ok({}));
});
afterEach(() => {
  cleanup();
  act(() => {
    hideSessionLogs();
  });
});

describe('HostSessionLogs', () => {
  it('is off by default and turns logging on for the host', async () => {
    render(<HostSessionLogs hostId="web" path={[]} groupName={groupName} />);
    const toggle = await screen.findByRole('switch', { name: 'Log sessions' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('No logs on this machine.')).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(sessionLog.setSwitch).toHaveBeenCalledWith({ target: { kind: 'host', id: 'web' }, on: true });
    });
  });

  it('shows the group the host follows, and lets a host switch go back to it', async () => {
    sessionLog.switches.mockResolvedValue(ok({ switches: { 'group:prod': true } }));
    const { unmount } = render(<HostSessionLogs hostId="web" path={['prod']} groupName={groupName} />);
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Log sessions' }).getAttribute('aria-checked')).toBe('true');
    });
    expect(screen.getByText('from Production')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Follow group' })).toBeNull();
    unmount();

    sessionLog.switches.mockResolvedValue(ok({ switches: { 'group:prod': true, 'host:web': false } }));
    render(<HostSessionLogs hostId="web" path={['prod']} groupName={groupName} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Follow group' }));
    await waitFor(() => {
      expect(sessionLog.setSwitch).toHaveBeenCalledWith({ target: { kind: 'host', id: 'web' }, on: null });
    });
  });

  it('lists the logs, opens one, filters its lines and reveals its file', async () => {
    sessionLog.list.mockResolvedValue(ok({ logs: [entry('20261013T183000Z-aaaaaaaa')] }));
    render(<HostSessionLogs hostId="web" path={[]} groupName={groupName} />);
    const row = await screen.findByTestId('session-log-row');
    expect(within(row).getByText(/^\d\d:\d\d · 2\.0 KB · exit 0$/)).toBeTruthy();

    fireEvent.click(within(row).getByRole('button', { name: 'Open log' }));
    const viewer = await screen.findByTestId('session-log-viewer');
    await waitFor(() => {
      expect(within(viewer).getByTestId('session-log-text').textContent).toBe('migrate\nERROR: x\ndone\n');
    });
    fireEvent.change(within(viewer).getByLabelText('Filter lines'), { target: { value: 'error' } });
    expect(within(viewer).getByTestId('session-log-text').textContent).toBe('    2  ERROR: x');
    expect(sessionLog.read).toHaveBeenCalledWith({ hostId: 'web', id: '20261013T183000Z-aaaaaaaa' });
    fireEvent.click(within(viewer).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByTestId('session-log-viewer')).toBeNull();
    });

    fireEvent.click(within(row).getByRole('button', { name: 'Reveal log file' }));
    await waitFor(() => {
      expect(sessionLog.reveal).toHaveBeenCalledWith({ hostId: 'web', id: '20261013T183000Z-aaaaaaaa' });
    });
  });

  it('searches the logs and shows only those that match, with the first matching line', async () => {
    sessionLog.list.mockResolvedValue(
      ok({ logs: [entry('20261013T190000Z-bbbbbbbb'), entry('20261013T183000Z-aaaaaaaa')] }),
    );
    sessionLog.search.mockResolvedValue(
      ok({ matches: [{ id: '20261013T183000Z-aaaaaaaa', count: 3, line: 12, text: 'ERROR: disk' }] }),
    );
    render(<HostSessionLogs hostId="web" path={[]} groupName={groupName} />);
    expect(await screen.findAllByTestId('session-log-row')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Search session logs'), { target: { value: 'error' } });
    await waitFor(() => {
      expect(screen.getAllByTestId('session-log-row')).toHaveLength(1);
    });
    expect(sessionLog.search).toHaveBeenCalledWith({ hostId: 'web', query: 'error' });
    expect(screen.getByText(/12: ERROR: disk/).textContent).toBe('12: ERROR: disk (+2 more)');
  });

  it('deletes a log after asking, and cannot delete one a session is still writing', async () => {
    sessionLog.list.mockResolvedValue(
      ok({ logs: [entry('20261013T190000Z-bbbbbbbb', { live: true }), entry('20261013T183000Z-aaaaaaaa')] }),
    );
    render(<HostSessionLogs hostId="web" path={[]} groupName={groupName} />);
    const [live, done] = await screen.findAllByTestId('session-log-row');
    expect(within(live as HTMLElement).getByText(/running/)).toBeTruthy();
    expect(within(live as HTMLElement).getByRole<HTMLButtonElement>('button', { name: 'Delete log' }).disabled).toBe(
      true,
    );
    fireEvent.click(within(done as HTMLElement).getByRole('button', { name: 'Delete log' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(sessionLog.delete).toHaveBeenCalledWith({ hostId: 'web', id: '20261013T183000Z-aaaaaaaa' });
    });
    await waitFor(() => {
      expect(sessionLog.list).toHaveBeenCalledTimes(2);
    });
  });
});

describe('logSummary (#534)', () => {
  it('reads like "11:09 · 16 B · exit 0"', () => {
    const at = new Date(2026, 9, 14, 11, 9).toISOString();
    expect(logSummary(entry('x', { startedAt: at, bytes: 16 }))).toBe('11:09 · 16 B · exit 0');
    expect(logSummary(entry('x', { startedAt: at, bytes: 3 * 1024 * 1024, live: true }))).toBe('11:09 · running');
    expect(logSummary(entry('x', { startedAt: at, reason: 'lost', exitCode: null }))).toBe(
      '11:09 · 2.0 KB · connection lost',
    );
  });
});

describe('SessionLogsDialog (#534)', () => {
  it('lists every host’s logs under their day, filters by host and opens one from its host', async () => {
    sessionLog.list.mockResolvedValue(
      ok({
        logs: [
          entry('20261013T190000Z-bbbbbbbb', { hostId: 'db', hostName: 'Database' }),
          entry('20261013T183000Z-aaaaaaaa'),
        ],
      }),
    );
    render(<SessionLogsDialog />);
    expect(screen.queryByTestId('session-logs-dialog')).toBeNull();
    act(() => {
      showSessionLogs();
    });
    const dialog = await screen.findByTestId('session-logs-dialog');
    const rows = await within(dialog).findAllByTestId('session-log-row');
    expect(sessionLog.list).toHaveBeenCalledWith({});
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^Database\d\d:\d\d · 2\.0 KB · exit 0$/),
      expect.stringMatching(/^Web\d\d:\d\d · 2\.0 KB · exit 0$/),
    ]);
    fireEvent.change(within(dialog).getByLabelText('Filter by host'), { target: { value: 'data' } });
    expect(within(dialog).getAllByTestId('session-log-row')).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open log' }));
    await waitFor(() => {
      expect(sessionLog.read).toHaveBeenCalledWith({ hostId: 'db', id: '20261013T190000Z-bbbbbbbb' });
    });
  });

  it('opens from a host’s panel', async () => {
    render(
      <>
        <HostSessionLogs hostId="web" path={[]} groupName={groupName} />
        <SessionLogsDialog />
      </>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'All hosts…' }));
    expect(await screen.findByTestId('session-logs-dialog')).toBeTruthy();
    expect(await screen.findAllByText('No logs on this machine.')).toHaveLength(2);
  });
});

describe('groupLogged', () => {
  const FILE = {
    version: 1 as const,
    groups: [
      {
        id: 'root',
        name: 'Root',
        tags: [],
        ssh: {},
        hosts: [],
        groups: [{ id: 'prod', name: 'Production', tags: [], ssh: {}, groups: [], hosts: [] }],
      },
    ],
    hosts: [],
  } as unknown as HostsFileWire;

  it('takes the group’s own switch, else the nearest above, else off', () => {
    expect(groupLogged(FILE, {}, 'prod')).toBe(false);
    expect(groupLogged(FILE, { 'group:root': true }, 'prod')).toBe(true);
    expect(groupLogged(FILE, { 'group:root': true, 'group:prod': false }, 'prod')).toBe(false);
  });
});
