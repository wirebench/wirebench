import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalShareStateEvent, TerminalShareViewerStateEvent } from '@wirebench/wire/terminal-share-wire';

const terminalShare = {
  available: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  grant: vi.fn(),
  decline: vi.fn(),
  remove: vi.fn(),
  takeBack: vi.fn(),
  preview: vi.fn(),
  join: vi.fn(),
  leave: vi.fn(),
  input: vi.fn(),
  requestControl: vi.fn(),
  release: vi.fn(),
};
vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({ terminalShare }) }));

// A terminal that records what it was given: jsdom has no canvas for the real one.
const terminals = vi.hoisted(() => [] as { written: string[]; type: (data: string) => void; size: number[] }[]);
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    written: string[] = [];
    size: number[] = [];
    private listener: ((data: string) => void) | undefined;
    constructor() {
      terminals.push(this);
    }
    type(data: string): void {
      this.listener?.(data);
    }
    attachCustomKeyEventHandler(): void {}
    open(): void {}
    focus(): void {}
    write(bytes: Uint8Array): void {
      this.written.push(new TextDecoder().decode(bytes));
    }
    resize(cols: number, rows: number): void {
      this.size = [cols, rows];
    }
    onData(listener: (data: string) => void) {
      this.listener = listener;
      return { dispose: () => undefined };
    }
    dispose(): void {}
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const { ShareStrip } = await import('../../src/renderer/features/ssh/share-strip.js');
const { JoinShareDialog } = await import('../../src/renderer/features/ssh/join-share-dialog.js');
const { ShareViewTab } = await import('../../src/renderer/features/ssh/share-view-tab.js');
const store = await import('../../src/renderer/features/ssh/terminal-share-store.js');
const { useEditorsStore } = await import('../../src/renderer/state/editors.js');

const ok = <T,>(value: T) => ({ ok: true as const, value });
const BOB = 'u-bob';
const ME = 'u-me';
const SHARE: TerminalShareStateEvent = {
  sessionId: 's1',
  shareId: 'abcdefghijklmnopqrstuvwxyz',
  invite: 'wirebench://terminal-share/abcdefghijklmnopqrstuvwxyz?server=x&workspace=y',
  viewers: [
    { userId: BOB, name: 'Bob', control: false, requesting: true },
    { userId: 'u-cy', name: 'Cy', control: true, requesting: false },
  ],
  control: 'u-cy',
};

const listeners = new Map<string, (payload: unknown) => void>();
beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(terminalShare)) fn.mockResolvedValue(ok({}));
  store.useTerminalShareStore.setState({ available: undefined, owned: {}, views: {}, joinOpen: false });
  terminals.length = 0;
  (window as unknown as { wirebench: unknown }).wirebench = {
    on: (name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
  };
});
afterEach(() => {
  cleanup();
});

describe('ShareStrip (#429)', () => {
  it('shows who watches and who types, and acts on requests, viewers and the share', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ShareStrip share={SHARE} />);
    expect(screen.getByText('Sharing · 2 watching')).toBeTruthy();
    expect(screen.getByTestId('share-viewer-Cy').textContent).toContain('has control');
    expect(screen.getByTestId('share-request').textContent).toContain('Bob asks for control');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(terminalShare.grant).toHaveBeenCalledWith({ sessionId: 's1', userId: BOB });
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(terminalShare.decline).toHaveBeenCalledWith({ sessionId: 's1', userId: BOB });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bob' }));
    expect(terminalShare.remove).toHaveBeenCalledWith({ sessionId: 's1', userId: BOB });
    fireEvent.click(screen.getByRole('button', { name: 'Take back control' }));
    expect(terminalShare.takeBack).toHaveBeenCalledWith({ sessionId: 's1' });
    fireEvent.click(screen.getByRole('button', { name: 'Copy invite link' }));
    expect(writeText).toHaveBeenCalledWith(SHARE.invite);
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));
    expect(terminalShare.stop).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('says nobody watches yet, and offers no take back without a holder', () => {
    render(<ShareStrip share={{ ...SHARE, viewers: [], control: null }} />);
    expect(screen.getByText('Sharing · nobody watching yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Take back control' })).toBeNull();
  });
});

describe('the share store (#429)', () => {
  it('keeps an owned share until it ends, and holds a view’s output until its terminal takes it', () => {
    const off = store.subscribeToShareEvents();
    listeners.get('terminalShare.state')!(SHARE);
    expect(store.useTerminalShareStore.getState().owned['s1']).toEqual(SHARE);
    listeners.get('terminalShare.state')!({ ...SHARE, ended: 'ended' });
    expect(store.useTerminalShareStore.getState().owned['s1']).toBeUndefined();

    listeners.get('terminalShare.viewerData')!({ viewId: 'v1', data: btoa('early ') });
    const got: string[] = [];
    store.attachShareView('v1', (bytes) => got.push(new TextDecoder().decode(bytes)));
    listeners.get('terminalShare.viewerData')!({ viewId: 'v1', data: btoa('late') });
    expect(got).toEqual(['early ', 'late']);
    off();
  });

  it('startShare records the share at once, and says why it could not', async () => {
    terminalShare.start.mockResolvedValueOnce(ok({ shareId: SHARE.shareId, invite: SHARE.invite }));
    expect(await store.startShare({ sessionId: 's9', hostName: 'web', cols: 80, rows: 24 })).toEqual({
      ok: true,
      invite: SHARE.invite,
    });
    expect(store.useTerminalShareStore.getState().owned['s9']?.viewers).toEqual([]);
    terminalShare.start.mockResolvedValueOnce({ ok: false, error: { message: 'Not on this server' } });
    expect(await store.startShare({ sessionId: 's8', hostName: 'web', cols: 80, rows: 24 })).toEqual({
      ok: false,
      message: 'Not on this server',
    });
  });
});

describe('JoinShareDialog (#429)', () => {
  it('previews a pasted link and joins it in a new tab', async () => {
    terminalShare.preview.mockResolvedValue(
      ok({ server: 'https://wb', hostName: 'web', ownerName: 'Alice', viewers: 1 }),
    );
    terminalShare.join.mockResolvedValue(ok({ viewId: 'x', hostName: 'web', ownerName: 'Alice', cols: 80, rows: 24 }));
    const open = vi.spyOn(useEditorsStore.getState(), 'open').mockImplementation(() => undefined);
    store.openJoinShare();
    render(<JoinShareDialog />);
    fireEvent.change(screen.getByLabelText('Invite link'), { target: { value: SHARE.invite } });
    expect((await screen.findByTestId('join-share-preview')).textContent).toBe('Alice’s terminal on web · 1 watching');
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => {
      expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'terminal-share', title: 'Alice · web' }));
    });
    expect(terminalShare.join).toHaveBeenCalledWith({ link: SHARE.invite, viewId: expect.any(String) as string });
    expect(store.useTerminalShareStore.getState().joinOpen).toBe(false);
  });

  it('keeps the state that arrives before join answers, so the count is right at once (#690)', async () => {
    const off = store.subscribeToShareEvents();
    let viewId = '';
    terminalShare.join.mockImplementation((request: { viewId: string }) => {
      viewId = request.viewId;
      listeners.get('terminalShare.viewerState')!({
        viewId,
        viewers: [{ userId: ME, name: 'Me', control: false, requesting: false }],
        control: null,
        self: ME,
        requesting: false,
        cols: 120,
        rows: 40,
      });
      return Promise.resolve(ok({ viewId, hostName: 'web', ownerName: 'Alice', cols: 80, rows: 24 }));
    });
    vi.spyOn(useEditorsStore.getState(), 'open').mockImplementation(() => undefined);
    expect(await store.joinShare(SHARE.invite)).toEqual({ ok: true });
    expect(store.useTerminalShareStore.getState().views[viewId]).toMatchObject({
      cols: 120,
      rows: 40,
      state: { viewers: [{ userId: ME }] },
    });
    off();
  });

  it('shows why a link cannot be joined', async () => {
    terminalShare.preview.mockResolvedValue({ ok: false, error: { message: 'That is not a shared terminal link.' } });
    store.openJoinShare();
    render(<JoinShareDialog />);
    fireEvent.change(screen.getByLabelText('Invite link'), { target: { value: 'nope' } });
    expect((await screen.findByRole('alert')).textContent).toBe('That is not a shared terminal link.');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Join' }).disabled).toBe(true);
  });
});

describe('ShareViewTab (#429)', () => {
  const state = (over: Partial<TerminalShareViewerStateEvent> = {}): TerminalShareViewerStateEvent => ({
    viewId: 'v1',
    owner: { userId: 'u-alice', name: 'Alice' },
    viewers: [{ userId: ME, name: 'Me', control: false, requesting: false }],
    control: null,
    self: ME,
    requesting: false,
    cols: 100,
    rows: 30,
    ...over,
  });
  const setView = (event: TerminalShareViewerStateEvent): void => {
    act(() => {
      store.useTerminalShareStore.setState({
        views: { v1: { hostName: 'web', ownerName: 'Alice', cols: event.cols, rows: event.rows, state: event } },
      });
    });
  };

  it('is view only until control is granted; then typing goes to the share', () => {
    setView(state());
    render(<ShareViewTab tabId="terminal-share:v1" />);
    const term = terminals[0]!;
    expect(term.size).toEqual([100, 30]);
    expect(screen.getByTestId('share-view-control').textContent).toBe('View only');
    term.type('x');
    expect(terminalShare.input).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Request control' }));
    expect(terminalShare.requestControl).toHaveBeenCalledWith({ viewId: 'v1' });
    setView(state({ control: ME }));
    expect(screen.getByTestId('share-view-control').textContent).toBe('You have control');
    term.type('ls');
    expect(terminalShare.input).toHaveBeenCalledWith({ viewId: 'v1', data: btoa('ls') });
    fireEvent.click(screen.getByRole('button', { name: 'Release control' }));
    expect(terminalShare.release).toHaveBeenCalledWith({ viewId: 'v1' });
  });

  it('counts this user among those watching, as the owner does (#690)', () => {
    setView(state({ viewers: [{ userId: ME, name: 'Me', control: false, requesting: false }] }));
    render(<ShareViewTab tabId="terminal-share:v1" />);
    expect(screen.getByTestId('share-view-watching').textContent).toBe('1 watching');
    expect(screen.getByText('Me (you)')).toBeTruthy();
  });

  it('says why the share ended, offers to close the tab, and leaves it when the tab closes', () => {
    const close = vi.spyOn(useEditorsStore.getState(), 'close').mockImplementation(() => undefined);
    setView(state({ ended: 'removed' }));
    const { unmount } = render(<ShareViewTab tabId="terminal-share:v1" />);
    expect(screen.getByTestId('share-view-ended').textContent).toBe('The owner removed you from this shared terminal.');
    expect(screen.queryByRole('button', { name: 'Request control' })).toBeNull();
    // An ended share has no count and no chips, even with a stale viewer list.
    expect(screen.queryByTestId('share-view-watching')).toBeNull();
    expect(screen.queryByText('Me (you)')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close tab' }));
    expect(close).toHaveBeenCalledWith('terminal-share:v1');
    unmount();
    expect(terminalShare.leave).toHaveBeenCalledWith({ viewId: 'v1' });
  });
});
