// @vitest-environment node
/**
 * The `secretScan.*` channels: routed to the named project's session, and validated on the way out
 * so that a finding carrying its value can never reach the renderer, even from a faulty session.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSecretScanChannels } from '../src/main/ipc/secret-scan.js';
import type { SecretScanSession, SecretScanSessions } from '../src/main/secret-scan-session.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload: unknown, sender: unknown = {}): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender }, payload);
}

const FINDING = {
  id: '0123456789abcdef',
  location: { kind: 'project-property', name: 'token' },
  rule: 'sensitive-name',
  label: 'Project › property token',
  preview: 'fak… (24 chars)',
} as const;

function register(
  session: Partial<SecretScanSession>,
  holds: Partial<Pick<SecretScanSessions, 'hold' | 'release' | 'releaseOwner'>> = {},
): { projects: string[] } {
  const projects: string[] = [];
  const sessions: Pick<SecretScanSessions, 'session' | 'hold' | 'release' | 'releaseOwner'> = {
    session: (projectId) => {
      projects.push(projectId);
      return session as SecretScanSession;
    },
    hold: holds.hold ?? (() => 'hold-1'),
    release: holds.release ?? (() => undefined),
    releaseOwner: holds.releaseOwner ?? (() => undefined),
  };
  registerSecretScanChannels(sessions);
  return { projects };
}

/** A renderer as main sees it: an id, and the lifecycle events `hold` listens for. */
function fakeSender(id: number): EventEmitter & { id: number } {
  return Object.assign(new EventEmitter(), { id });
}

beforeEach(() => {
  handlers.clear();
});

describe('secretScan channels', () => {
  it('answers scan from the named project and passes keep and move through', async () => {
    const keep = vi.fn();
    const move = vi.fn().mockResolvedValue({ moved: [FINDING.id], stale: [], nameTaken: [] });
    const { projects } = register({
      review: () => Promise.resolve({ findings: [FINDING], proposedNames: { [FINDING.id]: 'token' }, storedNames: [] }),
      keep,
      move,
    });

    expect(await invoke('secretScan.scan', { projectId: 'p1' })).toEqual({
      ok: true,
      value: { findings: [FINDING], proposedNames: { [FINDING.id]: 'token' }, storedNames: [] },
    });
    expect(await invoke('secretScan.keep', { projectId: 'p1', ids: [FINDING.id] })).toEqual({ ok: true, value: {} });
    expect(keep).toHaveBeenCalledWith([FINDING.id]);
    expect(await invoke('secretScan.move', { projectId: 'p1', items: [{ id: FINDING.id, name: 'token' }] })).toEqual({
      ok: true,
      value: { moved: [FINDING.id], stale: [], nameTaken: [] },
    });
    expect(move).toHaveBeenCalledWith([{ id: FINDING.id, name: 'token' }]);
    expect(projects).toEqual(['p1', 'p1', 'p1']);
  });

  it('refuses to send a finding that carries its value', async () => {
    register({
      review: () =>
        Promise.resolve({
          findings: [{ ...FINDING, value: 'fake-token-not-real-0000' } as typeof FINDING],
          proposedNames: {},
          storedNames: [],
        }),
    });

    const result = (await invoke('secretScan.scan', { projectId: 'p1' })) as { ok: boolean; error?: { code: string } };

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ipc-invalid-response');
    expect(JSON.stringify(result)).not.toContain('fake-token-not-real-0000');
  });

  it('rejects a move to a name a token cannot carry', async () => {
    const move = vi.fn();
    register({ move });

    const result = (await invoke('secretScan.move', {
      projectId: 'p1',
      items: [{ id: FINDING.id, name: 'not a name' }],
    })) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(move).not.toHaveBeenCalled();
  });

  it('holds autosave for the named projects on behalf of the renderer that asked, and releases by id', async () => {
    const hold = vi.fn().mockReturnValue('hold-7');
    const release = vi.fn();
    register({}, { hold, release });
    const sender = fakeSender(3);

    expect(await invoke('secretScan.hold', { projectIds: ['p1', 'p2'] }, sender)).toEqual({
      ok: true,
      value: { holdId: 'hold-7' },
    });
    expect(hold).toHaveBeenCalledWith(['p1', 'p2'], 3);
    expect(await invoke('secretScan.release', { holdId: 'hold-7' }, sender)).toEqual({ ok: true, value: {} });
    expect(release).toHaveBeenCalledWith('hold-7');
  });

  it.each(['destroyed', 'render-process-gone', 'did-navigate'])(
    "drops a renderer's holds when it goes away (%s), so autosave cannot stay off",
    async (event) => {
      const releaseOwner = vi.fn();
      register({}, { releaseOwner });
      const sender = fakeSender(5);
      await invoke('secretScan.hold', { projectIds: ['p1'] }, sender);
      // A second hold from the same window does not stack listeners.
      await invoke('secretScan.hold', { projectIds: ['p1'] }, sender);
      expect(releaseOwner).not.toHaveBeenCalled();

      sender.emit(event);

      expect(releaseOwner).toHaveBeenCalledTimes(1);
      expect(releaseOwner).toHaveBeenCalledWith(5);
    },
  );
});
