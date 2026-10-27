/**
 * The `hooks.*` channels (webhook-capture spec §4.1). Each hands the request to `HooksService`, which
 * resolves the account's token and holds the open views; the token never crosses the bridge.
 */
import { channels } from '../../shared/ipc.js';
import type { HooksService } from '../hooks/hooks-service.js';
import { registerHandler, type HandlerTable } from './register.js';

export interface HooksChannelDeps {
  readonly hooks: Pick<
    HooksService,
    | 'status'
    | 'list'
    | 'create'
    | 'update'
    | 'rotate'
    | 'remove'
    | 'clear'
    | 'unseen'
    | 'watch'
    | 'unwatch'
    | 'open'
    | 'older'
    | 'capture'
    | 'close'
  >;
}

const DONE = { done: true } as const;

export function registerHooksChannels(table: HandlerTable, deps: HooksChannelDeps): void {
  const h = deps.hooks;
  const ref = (r: { readonly url: string; readonly workspaceId: string; readonly hookId: string }) => ({
    url: r.url,
    workspaceId: r.workspaceId,
    hookId: r.hookId,
  });

  registerHandler(table, channels.hooks.status, async (r) => ({ hooks: await h.status(r.url) }));
  registerHandler(table, channels.hooks.list, async (r) => ({ hooks: await h.list(r.url, r.workspaceId) }));
  registerHandler(table, channels.hooks.create, async ({ url, workspaceId, ...body }) => ({
    hook: await h.create(url, workspaceId, body),
  }));
  registerHandler(table, channels.hooks.update, async ({ url, workspaceId, hookId, ...patch }) => ({
    hook: await h.update({ url, workspaceId, hookId }, patch),
  }));
  registerHandler(table, channels.hooks.rotate, async (r) => ({ hook: await h.rotate(ref(r)) }));
  registerHandler(table, channels.hooks.remove, async (r) => {
    await h.remove(ref(r));
    return DONE;
  });
  registerHandler(table, channels.hooks.clear, async (r) => {
    await h.clear(ref(r));
    return DONE;
  });
  registerHandler(table, channels.hooks.unseen, (r) => h.unseen(ref(r), r.after));
  registerHandler(table, channels.hooks.watch, (r) => {
    h.watch(r.url, r.workspaceId);
    return Promise.resolve(DONE);
  });
  registerHandler(table, channels.hooks.unwatch, (r) => {
    h.unwatch(r.url, r.workspaceId);
    return Promise.resolve(DONE);
  });
  registerHandler(table, channels.hooks.open, (r) => h.open(ref(r)));
  registerHandler(table, channels.hooks.older, (r) => h.older(r.viewId));
  registerHandler(table, channels.hooks.capture, async (r) => ({ capture: await h.capture(r.viewId, r.captureId) }));
  registerHandler(table, channels.hooks.close, (r) => {
    h.close(r.viewId);
    return Promise.resolve(DONE);
  });
}
