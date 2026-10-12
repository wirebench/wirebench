import { beforeEach, describe, expect, it, vi } from 'vitest';

const open = vi.fn();
const list = vi.fn();
const close = vi.fn();
const trustHostKey = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ sftp: { open, list, close }, ssh: { trustHostKey } }),
}));
import { confirmTrust } from '../../src/renderer/features/ssh/connect.js';
import { FILES_PREFS_KEY, readFilesPrefs } from '../../src/renderer/features/ssh/files/files-prefs.js';
import { useFilesStore } from '../../src/renderer/features/ssh/files/files-store.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';

const TAB = 'ssh-files:a';
const ENTRY = { name: 'app', type: 'dir', size: 0, mtime: 0, mode: 0o755 } as const;

function listing(path: string, names: readonly string[] = ['app']) {
  return { ok: true, value: { path, entries: names.map((name) => ({ ...ENTRY, name })) } };
}

const NEW_KEY = {
  ok: false,
  error: {
    code: 'ssh-host-key-new',
    message: 'untrusted',
    details: { host: 'h:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:k' },
  },
};

beforeEach(() => {
  localStorage.clear();
  open.mockReset();
  list.mockReset();
  close.mockReset().mockResolvedValue({ ok: true, value: {} });
  trustHostKey.mockReset();
  useFilesStore.setState({ panes: {}, showHidden: false });
  useHostsStore.setState({ trustPrompt: null, sessions: {}, connectFailed: {} });
  useEditorsStore.getState().reset();
  useEditorsStore.getState().open({ id: TAB, kind: 'ssh-files', title: 'a · Files', hostId: 'a' });
  useWorkspaceStore.setState({ workspace: { id: 'w1' } } as never);
});

describe('connect', () => {
  it('opens a session and lists the home folder', async () => {
    open.mockResolvedValueOnce({ ok: true, value: { sessionId: 's1', home: '/home/me' } });
    list.mockResolvedValueOnce(listing('/home/me'));
    await useFilesStore.getState().connect(TAB, 'a');
    const pane = useFilesStore.getState().panes[TAB];
    expect(pane).toMatchObject({ path: '/home/me', home: '/home/me', status: 'idle' });
    expect(pane?.place).toEqual({ kind: 'remote', hostId: 'a', sessionId: 's1' });
    expect(list).toHaveBeenCalledWith({ place: { kind: 'remote', sessionId: 's1' }, path: '/home/me' });
  });

  it('starts in the host’s last folder, remembered per workspace and host', async () => {
    localStorage.setItem(FILES_PREFS_KEY, JSON.stringify({ lastFolder: { 'w1/a': '/var/log' } }));
    open.mockResolvedValueOnce({ ok: true, value: { sessionId: 's1', home: '/home/me' } });
    list.mockResolvedValueOnce(listing('/var/log'));
    await useFilesStore.getState().connect(TAB, 'a');
    expect(useFilesStore.getState().panes[TAB]?.path).toBe('/var/log');
  });

  it('a remembered folder that is gone falls back to home without showing the refusal', async () => {
    localStorage.setItem(FILES_PREFS_KEY, JSON.stringify({ lastFolder: { 'w1/a': '/gone' } }));
    open.mockResolvedValueOnce({ ok: true, value: { sessionId: 's1', home: '/home/me' } });
    list.mockResolvedValueOnce({ ok: false, error: { code: 'sftp-not-found', message: 'no /gone' } });
    list.mockResolvedValueOnce(listing('/home/me'));
    await useFilesStore.getState().connect(TAB, 'a');
    const pane = useFilesStore.getState().panes[TAB];
    expect(pane?.path).toBe('/home/me');
    expect(pane?.error).toBeUndefined();
  });

  it('a refused connect leaves the pane in error with the reason', async () => {
    open.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-auth-failed', message: 'sign-in refused' } });
    await useFilesStore.getState().connect(TAB, 'a');
    expect(useFilesStore.getState().panes[TAB]).toMatchObject({
      status: 'error',
      error: { code: 'ssh-auth-failed', message: 'sign-in refused' },
    });
  });

  it('a new host key opens the trust dialog; trusting it connects again', async () => {
    open.mockResolvedValueOnce(NEW_KEY);
    await useFilesStore.getState().connect(TAB, 'a');
    expect(useHostsStore.getState().trustPrompt).toMatchObject({ hostId: 'a', fingerprint: 'SHA256:k' });
    expect(useFilesStore.getState().panes[TAB]?.status).toBe('connecting');

    trustHostKey.mockResolvedValueOnce({ ok: true, value: {} });
    open.mockResolvedValueOnce({ ok: true, value: { sessionId: 's1', home: '/root' } });
    list.mockResolvedValueOnce(listing('/root'));
    await confirmTrust(false);
    await vi.waitFor(() => {
      expect(useFilesStore.getState().panes[TAB]?.path).toBe('/root');
    });
    expect(useHostsStore.getState().connectFailed).toEqual({});
  });

  it('dismissing the trust dialog leaves the pane in error, not the terminal’s connect failed', async () => {
    open.mockResolvedValueOnce(NEW_KEY);
    await useFilesStore.getState().connect(TAB, 'a');
    useHostsStore.getState().cancelTrust();
    expect(useFilesStore.getState().panes[TAB]?.status).toBe('error');
    expect(useHostsStore.getState().connectFailed).toEqual({});
  });

  it('a second connect while one is in flight opens no second session', async () => {
    open.mockResolvedValueOnce({ ok: true, value: { sessionId: 's1', home: '/' } });
    list.mockResolvedValue(listing('/'));
    await Promise.all([useFilesStore.getState().connect(TAB, 'a'), useFilesStore.getState().connect(TAB, 'a')]);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('a tab closed while connecting closes the session it got', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    open.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const pending = useFilesStore.getState().connect(TAB, 'a');
    useEditorsStore.getState().close(TAB);
    useFilesStore.getState().close(TAB);
    resolve({ ok: true, value: { sessionId: 's1', home: '/' } });
    await pending;
    expect(close).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(useFilesStore.getState().panes[TAB]).toBeUndefined();
  });
});

describe('navigation', () => {
  beforeEach(async () => {
    open.mockResolvedValueOnce({ ok: true, value: { sessionId: 's1', home: '/home/me' } });
    list.mockResolvedValueOnce(listing('/home/me'));
    await useFilesStore.getState().connect(TAB, 'a');
  });

  it('navigate with push records the folder left; Back returns to it', async () => {
    list.mockResolvedValueOnce(listing('/etc'));
    await useFilesStore.getState().navigate(TAB, '/etc', { push: true });
    expect(useFilesStore.getState().panes[TAB]?.history).toEqual(['/home/me']);
    list.mockResolvedValueOnce(listing('/home/me'));
    await useFilesStore.getState().back(TAB);
    expect(useFilesStore.getState().panes[TAB]).toMatchObject({ path: '/home/me', history: [] });
  });

  it('Up lists the parent folder', async () => {
    list.mockResolvedValueOnce(listing('/home'));
    await useFilesStore.getState().up(TAB);
    expect(list).toHaveBeenLastCalledWith({ place: { kind: 'remote', sessionId: 's1' }, path: '/home' });
  });

  it('a refused path keeps the listing and says why', async () => {
    list.mockResolvedValueOnce({ ok: false, error: { code: 'sftp-not-found', message: '/nope does not exist' } });
    expect(await useFilesStore.getState().navigate(TAB, '/nope', { push: true })).toBe(false);
    expect(useFilesStore.getState().panes[TAB]).toMatchObject({
      path: '/home/me',
      status: 'idle',
      error: { code: 'sftp-not-found', message: '/nope does not exist' },
      history: [],
    });
    expect(useFilesStore.getState().panes[TAB]?.entries.map((e) => e.name)).toEqual(['app']);
  });

  it('remembers the folder per workspace and host', async () => {
    list.mockResolvedValueOnce(listing('/srv'));
    await useFilesStore.getState().navigate(TAB, '/srv');
    expect(readFilesPrefs().lastFolder).toEqual({ 'w1/a': '/srv' });
  });

  it('an older listing that lands after a newer one is dropped', async () => {
    let first: (value: unknown) => void = () => undefined;
    list.mockReturnValueOnce(
      new Promise((r) => {
        first = r;
      }),
    );
    list.mockResolvedValueOnce(listing('/b'));
    const slow = useFilesStore.getState().navigate(TAB, '/a');
    await useFilesStore.getState().navigate(TAB, '/b');
    first(listing('/a'));
    await slow;
    expect(useFilesStore.getState().panes[TAB]?.path).toBe('/b');
  });

  it('Refresh keeps what is still there selected', async () => {
    useFilesStore.getState().select(TAB, ['app', 'old']);
    list.mockResolvedValueOnce(listing('/home/me', ['app', 'new']));
    await useFilesStore.getState().refresh(TAB);
    expect(useFilesStore.getState().panes[TAB]?.selected).toEqual(['app']);
  });

  it('a closed session puts the pane in error; closing the tab then sends nothing', () => {
    useFilesStore.getState().noteClosed('s1');
    expect(useFilesStore.getState().panes[TAB]).toMatchObject({
      status: 'error',
      place: { kind: 'remote', hostId: 'a' },
    });
    useFilesStore.getState().close(TAB);
    expect(close).not.toHaveBeenCalled();
    expect(useFilesStore.getState().panes[TAB]).toBeUndefined();
  });

  it('closing the tab closes its session', () => {
    useFilesStore.getState().close(TAB);
    expect(close).toHaveBeenCalledWith({ sessionId: 's1' });
  });
});

it('the hidden toggle is remembered on this machine', () => {
  useFilesStore.getState().setShowHidden(true);
  expect(readFilesPrefs().showHidden).toBe(true);
});
