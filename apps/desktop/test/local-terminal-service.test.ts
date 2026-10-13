// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { LocalTerminalService } from '../src/main/local-terminal-service.js';
import type { LocalPty, LocalPtySpawn, LocalTerminalDeps } from '../src/main/local-terminal-service.js';

function sender(id: number) {
  const listeners = new Map<string, ((details?: unknown) => void)[]>();
  const add = (name: string, listener: (details?: unknown) => void) =>
    listeners.set(name, [...(listeners.get(name) ?? []), listener]);
  let destroyed = false;
  return {
    id,
    isDestroyed: () => destroyed,
    once: vi.fn(add),
    on: vi.fn(add),
    fire: (name: string, details?: unknown) => {
      if (name === 'destroyed') destroyed = true;
      for (const listener of listeners.get(name) ?? []) listener(details);
    },
  };
}

function fakePty() {
  let onData: ((data: string) => void) | undefined;
  let onExit: ((exit: { exitCode: number; signal?: number }) => void) | undefined;
  const write = vi.fn<LocalPty['write']>();
  const resize = vi.fn<LocalPty['resize']>();
  const kill = vi.fn<LocalPty['kill']>();
  const pty: LocalPty = {
    write,
    resize,
    kill,
    onData: (listener) => {
      onData = listener;
      return { dispose: () => (onData = undefined) };
    },
    onExit: (listener) => {
      onExit = listener;
      return { dispose: () => (onExit = undefined) };
    },
  };
  return {
    pty,
    write,
    resize,
    kill,
    print: (text: string) => onData?.(text),
    exit: (exitCode: number) => onExit?.({ exitCode }),
  };
}

function make(overrides: Partial<LocalTerminalDeps> = {}) {
  const ptys: ReturnType<typeof fakePty>[] = [];
  const spawn = vi.fn<LocalPtySpawn>(() => {
    const fake = fakePty();
    ptys.push(fake);
    return fake.pty;
  });
  const emit = vi.fn<(target: unknown, event: { name: string }, payload: unknown) => void>();
  let n = 0;
  const service = new LocalTerminalService({
    load: () => Promise.resolve(spawn),
    emit,
    shell: () => ({ file: '/bin/zsh', args: ['-l'], name: 'zsh' }),
    cwd: () => '/Users/ada',
    env: () => ({ PATH: '/bin', TERM: 'xterm-256color' }),
    newId: () => `local-${String(++n)}`,
    ...overrides,
  });
  const events = (name: string) =>
    emit.mock.calls.filter(([, event]) => event.name === name).map(([, , payload]) => payload);
  return { service, spawn, ptys, emit, events };
}

const w = (id = 1) => sender(id) as unknown as Parameters<LocalTerminalService['open']>[0];

describe('LocalTerminalService', () => {
  it('starts the shell in a pseudo-terminal of the asked size, in the start folder', async () => {
    const { service, spawn } = make();
    const opened = await service.open(w(), { cols: 100, rows: 30 });
    expect(opened).toEqual({ sessionId: 'local-1', shell: 'zsh' });
    expect(spawn).toHaveBeenCalledWith('/bin/zsh', ['-l'], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: '/Users/ada',
      env: { PATH: '/bin', TERM: 'xterm-256color' },
    });
  });

  it('sends what the shell prints, base64, to the window that opened it', async () => {
    const { service, ptys, emit } = make();
    const owner = w();
    await service.open(owner, { cols: 80, rows: 24 });
    ptys[0]?.print('héllo\r\n');
    const [target, event, payload] = emit.mock.calls.at(-1) ?? [];
    expect(target).toBe(owner);
    expect(event?.name).toBe('localTerminal.data');
    expect(payload).toEqual({ sessionId: 'local-1', data: Buffer.from('héllo\r\n').toString('base64') });
  });

  it('writes keystrokes and resizes only for the owning window', async () => {
    const { service, ptys } = make();
    const owner = w(1);
    await service.open(owner, { cols: 80, rows: 24 });
    service.write(owner, { sessionId: 'local-1', data: Buffer.from('ls\r').toString('base64') });
    expect(ptys[0]?.write).toHaveBeenCalledWith('ls\r');
    service.resize(owner, { sessionId: 'local-1', cols: 120, rows: 40 });
    expect(ptys[0]?.resize).toHaveBeenCalledWith(120, 40);
    expect(() => {
      service.write(w(2), { sessionId: 'local-1', data: 'eA==' });
    }).toThrow(expect.objectContaining({ code: 'local-terminal-unknown' }) as Error);
  });

  it('reports the shell exiting with its code, and forgets the session', async () => {
    const { service, ptys, events } = make();
    const owner = w();
    await service.open(owner, { cols: 80, rows: 24 });
    ptys[0]?.exit(3);
    expect(events('localTerminal.exit')).toEqual([{ sessionId: 'local-1', code: 3 }]);
    expect(() => {
      service.write(owner, { sessionId: 'local-1', data: 'eA==' });
    }).toThrow();
  });

  it('close kills the shell and is quiet about it; another window cannot close it', async () => {
    const { service, ptys, events } = make();
    const owner = w(1);
    await service.open(owner, { cols: 80, rows: 24 });
    service.close(w(2), { sessionId: 'local-1' });
    expect(ptys[0]?.kill).not.toHaveBeenCalled();
    service.close(owner, { sessionId: 'local-1' });
    expect(ptys[0]?.kill).toHaveBeenCalled();
    ptys[0]?.exit(0);
    expect(events('localTerminal.exit')).toEqual([]);
    service.close(owner, { sessionId: 'local-1' });
  });

  it("ends a window's shells when the window goes, and leaves another window's alone", async () => {
    const { service, ptys } = make();
    const one = sender(1);
    const two = sender(2);
    await service.open(one as never, { cols: 80, rows: 24 });
    await service.open(two as never, { cols: 80, rows: 24 });
    one.fire('destroyed');
    expect(ptys[0]?.kill).toHaveBeenCalled();
    expect(ptys[1]?.kill).not.toHaveBeenCalled();
    service.disposeFor(two as never);
    expect(ptys[1]?.kill).toHaveBeenCalled();
  });

  it('refuses with local-terminal-unavailable when the pty binding does not load', async () => {
    const { service } = make({ load: () => Promise.reject(new Error('no binary for linux-riscv64')) });
    await expect(service.open(w(), { cols: 80, rows: 24 })).rejects.toMatchObject({
      code: 'local-terminal-unavailable',
      message: expect.stringContaining('no binary for linux-riscv64') as string,
    });
  });

  it('refuses with local-terminal-failed when the shell cannot start', async () => {
    const { service } = make({
      load: () =>
        Promise.resolve(() => {
          throw new Error('File not found: /bin/nope');
        }),
    });
    await expect(service.open(w(), { cols: 80, rows: 24 })).rejects.toMatchObject({
      code: 'local-terminal-failed',
      message: expect.stringContaining('/bin/nope') as string,
    });
  });
});
