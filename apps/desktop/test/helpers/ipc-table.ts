/**
 * Test plumbing for the `register*Channels` functions, which record their handlers in a
 * `HandlerTable` instead of binding `ipcMain`. A test keeps its own `handlers` map of
 * `(event, payload)` functions; {@link tableInto} makes a table whose entries land there the way
 * `bindIpc` would install them on `ipcMain`, so the test can keep invoking `handlers.get(name)`.
 */
import type { Caller } from '../../src/main/host/platform.js';
import type { HandlerTable } from '../../src/main/ipc/register.js';
import { runAsCaller } from '../../src/main/window-scope.js';

type Fake = Record<string, unknown>;

/**
 * Makes a test's fake `WebContents`-shaped sender a `Caller`, in place, so a test that asserts on
 * the very object it passed still sees it handed back. Anything the fake already has is kept: its
 * `send`, its `id`, its `isDestroyed` (which `isClosed` follows) and its `once`/`on` (which `onClosed`
 * and `onReset` listen through, for the `destroyed`, `render-process-gone` and `did-start-navigation` (`did-navigate` for a `commit` reset) events).
 */
export function asCaller<T extends object>(sender: T): T & Caller {
  const fake = sender as Fake;
  const call = (name: string, ...args: unknown[]): unknown =>
    typeof fake[name] === 'function' ? (fake[name] as (...a: unknown[]) => unknown)(...args) : undefined;
  fake['send'] ??= () => undefined;
  fake['isClosed'] ??= () => call('isDestroyed') === true;
  fake['onClosed'] ??= (listener: () => void) => {
    call('once', 'destroyed', listener);
    return () => {
      call('removeListener', 'destroyed', listener);
    };
  };
  fake['onReset'] ??= (listener: () => void, options?: { on?: 'start' | 'commit' }) => {
    call('on', 'render-process-gone', listener);
    if (options?.on === 'commit') call('on', 'did-navigate', listener);
    else
      call('on', 'did-start-navigation', (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) listener();
      });
    return () => undefined;
  };
  return sender as T & Caller;
}

/** A table whose entries are also installed in `handlers`, each run as `bindIpc` runs one; clearing `handlers` clears the table too. */
export function tableInto(
  handlers: Map<string, (event: never, payload: never) => unknown> | Map<string, (...args: never[]) => unknown>,
): HandlerTable {
  const table: HandlerTable = new Map();
  const set = table.set.bind(table);
  // A test that empties its `handlers` between cases starts a fresh registration, as a new app would.
  const clear = (handlers as Map<string, unknown>).clear.bind(handlers);
  (handlers as Map<string, unknown>).clear = () => {
    clear();
    table.clear();
  };
  table.set = (name, run) => {
    set(name, run);
    (handlers as Map<string, unknown>).set(name, (event: { sender?: object } | undefined, raw: unknown) => {
      const sender = event?.sender;
      if (sender === undefined) return run(raw, asCaller({ id: undefined }));
      const caller = asCaller(sender);
      return runAsCaller(caller.id, () => run(raw, caller));
    });
    return table;
  };
  return table;
}
