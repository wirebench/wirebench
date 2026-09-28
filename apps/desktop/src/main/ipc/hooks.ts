/**
 * The `hooks.*` channels (webhook-capture spec §4.1). Each hands the request to `HooksService`, which
 * resolves the account's token and holds the open views; the token never crosses the bridge.
 */
import { channels } from '../../shared/ipc.js';
import type { HooksService } from '../hooks/hooks-service.js';
import { registerHandler } from './register.js';

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

export function registerHooksChannels(deps: HooksChannelDeps): void {
  const h = deps.hooks;
  const ref = (r: { readonly url: string; readonly workspaceId: string; readonly hookId: string }) => ({
    url: r.url,
    workspaceId: r.workspaceId,
    hookId: r.hookId,
  });

  registerHandler(channels.hooks.status, async (r) => ({ hooks: await h.status(r.url) }));
  registerHandler(channels.hooks.list, async (r) => ({ hooks: await h.list(r.url, r.workspaceId) }));
  registerHandler(channels.hooks.create, async ({ url, workspaceId, ...body }) => ({
    hook: await h.create(url, workspaceId, body),
  }));
  registerHandler(channels.hooks.update, async ({ url, workspaceId, hookId, ...patch }) => ({
    hook: await h.update({ url, workspaceId, hookId }, patch),
  }));
  registerHandler(channels.hooks.rotate, async (r) => ({ hook: await h.rotate(ref(r)) }));
  registerHandler(channels.hooks.remove, async (r) => {
    await h.remove(ref(r));
    return DONE;
  });
  registerHandler(channels.hooks.clear, async (r) => {
    await h.clear(ref(r));
    return DONE;
  });
  registerHandler(channels.hooks.unseen, (r) => h.unseen(ref(r), r.after));
  registerHandler(channels.hooks.watch, (r) => {
    h.watch(r.url, r.workspaceId);
    return Promise.resolve(DONE);
  });
  registerHandler(channels.hooks.unwatch, (r) => {
    h.unwatch(r.url, r.workspaceId);
    return Promise.resolve(DONE);
  });
  registerHandler(channels.hooks.open, (r) => h.open(ref(r)));
  registerHandler(channels.hooks.older, (r) => h.older(r.viewId));
  registerHandler(channels.hooks.capture, async (r) => ({ capture: await h.capture(r.viewId, r.captureId) }));
  registerHandler(channels.hooks.close, (r) => {
    h.close(r.viewId);
    return Promise.resolve(DONE);
  });
}
