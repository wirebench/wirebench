/**
 * Catch URLs and their captures for the renderer (webhook-capture spec §4.1).
 *
 * A *view* is one open catch URL tab. It holds that catch URL's capture summaries, and the captures
 * opened in it, in memory until the tab closes. Nothing here touches the disk: a webhook body reaches
 * the laptop's storage only if someone copies it out.
 *
 * The service owns the live subscription for each (server, workspace) it watches, reference counted
 * between the Webhooks node and the open views:
 * - `capture` recounts a badge and fills the gap for the views of that catch URL;
 * - `hooks` re-lists and reloads every view of the workspace;
 * - a reconnect does both, because anything could have happened while the socket was down.
 *
 * Electron-free, like the other server modules of main (`server-token.ts`).
 */
import { randomUUID } from 'node:crypto';
import {
  decodeResponseText,
  detectLanguage,
  WirebenchError,
  type Capture,
  type CaptureSummary,
  type CatchUrl,
  type CatchUrlCreateRequest,
  type CatchUrlUpdateRequest,
} from '@wirebench/engine';
import type {
  CaptureViewWire,
  HooksCapturedEventWire,
  HooksCapturesEventWire,
  HooksChangedEventWire,
  HooksMetaWire,
} from '../../shared/wire-types.js';
import type { LiveEvent, LiveState } from '../live/live-client.js';
import type { LiveClients } from '../live/live-clients.js';
import { normalizeServerUrl, type ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';

/** Summaries a view opens with, and each "load older" adds. */
export const FIRST_PAGE = 50;
/** The gap fill's page: the server's largest (§3.5). */
export const GAP_PAGE = 200;
/** An unseen count stops here; the badge then reads "200+". */
export const UNSEEN_CAP = 200;

export interface HookRef {
  readonly url: string;
  readonly workspaceId: string;
  readonly hookId: string;
}

export interface HooksEmitter {
  changed(event: HooksChangedEventWire): void;
  captured(event: HooksCapturedEventWire): void;
  captures(event: HooksCapturesEventWire): void;
}

export interface HooksServiceDeps {
  readonly client: Pick<
    ServerClient,
    | 'meta'
    | 'listHooks'
    | 'createHook'
    | 'updateHook'
    | 'rotateHook'
    | 'deleteHook'
    | 'listCaptures'
    | 'getCapture'
    | 'clearCaptures'
  >;
  readonly accounts: TokenSource;
  readonly live: Pick<LiveClients, 'subscribe'>;
  readonly emit: HooksEmitter;
  /** `randomUUID` by default; tests pass a counter. */
  readonly newViewId?: () => string;
}

interface Watch {
  count: number;
  stop: () => void;
  /** The last state the subscription reported; `undefined` until its first. */
  state: LiveState | undefined;
}

interface View {
  readonly id: string;
  /** The server origin. */
  readonly url: string;
  readonly workspaceId: string;
  readonly hookId: string;
  /** Newest first. */
  summaries: CaptureSummary[];
  readonly details: Map<string, CaptureViewWire>;
  filling: boolean;
  /** A nudge arrived during the fill: run one more round when it ends. */
  again: boolean;
  /**
   * The view's own serial queue: `open`'s initial load, every fill, every reload and every `older`
   * run one at a time, in the order they were asked for. A task mutates `summaries`/`details` only
   * from inside its own turn, so nothing it reads or writes can be stepped on by another task that
   * started before it and is still awaiting a fetch (the fill/reload/clear race the review flagged).
   * `undefined` while nothing is running: {@link HooksService.enqueue} then starts the next task
   * synchronously, the same as calling it directly, so a fill triggered by a nudge that lands with
   * nothing else in flight still gets the fast path a single-flight fill needs (a coalesced nudge
   * must land before the fetch it will be folded into begins).
   */
  queue: Promise<unknown> | undefined;
}

type Page = { readonly before?: string; readonly after?: string; readonly limit: number };

const watchKey = (url: string, workspaceId: string): string => `${url} ${workspaceId}`;

function problemOf(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof WirebenchError) return { code: error.code, message: error.message };
  return { code: 'unexpected', message: error instanceof Error ? error.message : String(error) };
}

/** Newest-first, first occurrence wins. Defensive: the view's own queue should already prevent overlap. */
function dedupeNewestFirst(captures: readonly CaptureSummary[]): CaptureSummary[] {
  const seen = new Set<string>();
  const result: CaptureSummary[] = [];
  for (const capture of captures) {
    if (seen.has(capture.id)) continue;
    seen.add(capture.id);
    result.push(capture);
  }
  return result;
}

/** A capture as the response viewers take it, decoded as `rest/send.ts` decodes a response body. */
export function toCaptureView(capture: Capture): CaptureViewWire {
  const bytes = Buffer.from(capture.body, 'base64');
  const contentType = capture.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  const language = detectLanguage(contentType, bytes);
  const decoded = language === 'image' || language === 'binary' ? { text: '' } : decodeResponseText(bytes, contentType);
  return {
    id: capture.id,
    receivedAt: capture.receivedAt,
    method: capture.method,
    subpath: capture.subpath,
    bodySize: capture.bodySize,
    truncated: capture.truncated,
    sourceIp: capture.sourceIp,
    ...(capture.signature !== undefined && capture.signature !== null ? { signature: capture.signature } : {}),
    ...(capture.rejected === true ? { rejected: true } : {}),
    query: capture.query,
    headers: capture.headers,
    bodyBase64: capture.body,
    contentType: contentType ?? null,
    text: decoded.text,
    language,
    ...(decoded.problem !== undefined ? { decodeNote: decoded.problem } : {}),
  };
}

export class HooksService {
  private readonly watches = new Map<string, Watch>();
  private readonly views = new Map<string, View>();
  private readonly pending = new Set<Promise<void>>();
  private readonly newViewId: () => string;

  constructor(private readonly deps: HooksServiceDeps) {
    this.newViewId = deps.newViewId ?? randomUUID;
  }

  /** The server's `/meta` `hooks`, or `null` for a server without the module. No token needed. */
  async status(url: string): Promise<HooksMetaWire | null> {
    const meta = await this.deps.client.meta(normalizeServerUrl(url));
    return meta.hooks ?? null;
  }

  list(url: string, workspaceId: string): Promise<CatchUrl[]> {
    return withToken(this.deps, url, (origin, token) => this.deps.client.listHooks(origin, token, workspaceId));
  }

  create(url: string, workspaceId: string, body: CatchUrlCreateRequest): Promise<CatchUrl> {
    return withToken(this.deps, url, (origin, token) => this.deps.client.createHook(origin, token, workspaceId, body));
  }

  update(ref: HookRef, patch: CatchUrlUpdateRequest): Promise<CatchUrl> {
    return withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.updateHook(origin, token, ref.workspaceId, ref.hookId, patch),
    );
  }

  rotate(ref: HookRef): Promise<CatchUrl> {
    return withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.rotateHook(origin, token, ref.workspaceId, ref.hookId),
    );
  }

  async remove(ref: HookRef): Promise<void> {
    await withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.deleteHook(origin, token, ref.workspaceId, ref.hookId),
    );
  }

  /**
   * Clears on the server, then empties this device's open views of that catch URL. Each view's empty
   * runs on that view's own queue, behind any fill or reload already in flight for it, so a fill that
   * fetched before the clear can never resurrect what the clear just removed.
   */
  async clear(ref: HookRef): Promise<void> {
    await withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.clearCaptures(origin, token, ref.workspaceId, ref.hookId),
    );
    const url = normalizeServerUrl(ref.url);
    const matches = [...this.views.values()].filter(
      (view) => view.url === url && view.workspaceId === ref.workspaceId && view.hookId === ref.hookId,
    );
    await Promise.all(
      matches.map((view) =>
        this.enqueue(view, () =>
          Promise.resolve().then(() => {
            if (!this.isOpen(view)) return;
            view.summaries = [];
            view.details.clear();
            this.deps.emit.captures({ viewId: view.id, mode: 'replace', captures: [], more: false });
          }),
        ),
      ),
    );
  }

  /**
   * Captures after `after` (all of them for `null`), up to {@link UNSEEN_CAP}. Fetches one past the
   * cap so exactly `UNSEEN_CAP` unseen reads as `UNSEEN_CAP` with `more: false`, not `more: true`
   * (M2): only a page that spills past the cap counts as "more".
   */
  async unseen(ref: HookRef, after: string | null): Promise<{ readonly count: number; readonly more: boolean }> {
    const limit = UNSEEN_CAP + 1;
    const page = await this.page(ref, after === null ? { limit } : { after, limit });
    const more = page.length > UNSEEN_CAP;
    return { count: more ? UNSEEN_CAP : page.length, more };
  }

  /** Follows the workspace's live messages until the matching {@link unwatch}. */
  watch(url: string, workspaceId: string): void {
    const origin = normalizeServerUrl(url);
    const key = watchKey(origin, workspaceId);
    const existing = this.watches.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      return;
    }
    const watch: Watch = { count: 1, stop: () => undefined, state: undefined };
    this.watches.set(key, watch);
    watch.stop = this.deps.live.subscribe(origin, workspaceId, (event) => {
      this.onLive(origin, workspaceId, event);
    });
  }

  unwatch(url: string, workspaceId: string): void {
    const key = watchKey(normalizeServerUrl(url), workspaceId);
    const watch = this.watches.get(key);
    if (watch === undefined) return;
    watch.count -= 1;
    if (watch.count > 0) return;
    this.watches.delete(key);
    watch.stop();
  }

  /**
   * The view is registered and watching *before* the first page is fetched, so a nudge that lands
   * during that fetch finds a view to fill instead of being dropped (the fetch's own task runs first
   * on the view's queue, and a fill it triggers queues behind it, running once the fetch has set
   * `summaries`). If that first fetch fails, the view never existed as far as the caller is concerned
   * (they get the rejection, not a `viewId`), so it is closed again here: dropped from `views` and its
   * watch released, rather than left registered and watching forever with no one able to reach it.
   */
  async open(
    ref: HookRef,
  ): Promise<{ readonly viewId: string; readonly captures: CaptureSummary[]; readonly more: boolean }> {
    const view: View = {
      id: this.newViewId(),
      url: normalizeServerUrl(ref.url),
      workspaceId: ref.workspaceId,
      hookId: ref.hookId,
      summaries: [],
      details: new Map(),
      filling: false,
      again: false,
      queue: undefined,
    };
    this.views.set(view.id, view);
    this.watch(view.url, view.workspaceId);
    let captures: CaptureSummary[];
    try {
      captures = await this.enqueue(view, async () => {
        const page = await this.page(view, { limit: FIRST_PAGE });
        if (this.isOpen(view)) view.summaries = page;
        return page;
      });
    } catch (error) {
      this.close(view.id);
      throw error;
    }
    return { viewId: view.id, captures, more: captures.length === FIRST_PAGE };
  }

  async older(viewId: string): Promise<{ readonly captures: CaptureSummary[]; readonly more: boolean }> {
    const view = this.view(viewId);
    return this.enqueue(view, async () => {
      const oldest = view.summaries.at(-1);
      if (oldest === undefined) return { captures: [], more: false };
      const captures = await this.page(view, { before: oldest.id, limit: FIRST_PAGE });
      if (this.isOpen(view)) view.summaries = dedupeNewestFirst([...view.summaries, ...captures]);
      return { captures, more: captures.length === FIRST_PAGE };
    });
  }

  async capture(viewId: string, captureId: string): Promise<CaptureViewWire> {
    const view = this.view(viewId);
    const cached = view.details.get(captureId);
    if (cached !== undefined) return cached;
    const capture = await withToken(this.deps, view.url, (origin, token) =>
      this.deps.client.getCapture(origin, token, view.workspaceId, view.hookId, captureId),
    );
    const decoded = toCaptureView(capture);
    if (this.isOpen(view)) view.details.set(captureId, decoded);
    return decoded;
  }

  close(viewId: string): void {
    const view = this.views.get(viewId);
    if (view === undefined) return;
    this.views.delete(viewId);
    this.unwatch(view.url, view.workspaceId);
  }

  /** What is held in memory: tests pin that closing a view drops it all. */
  held(): { readonly views: number; readonly summaries: number; readonly captures: number } {
    let summaries = 0;
    let captures = 0;
    for (const view of this.views.values()) {
      summaries += view.summaries.length;
      captures += view.details.size;
    }
    return { views: this.views.size, summaries, captures };
  }

  /** Settles once every fill and reload under way has finished. Tests use it in place of sleeping. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Quit: stops every subscription and forgets every view. */
  dispose(): void {
    for (const watch of this.watches.values()) watch.stop();
    this.watches.clear();
    this.views.clear();
  }

  private view(viewId: string): View {
    const view = this.views.get(viewId);
    if (view === undefined) throw new WirebenchError('hooks-view-closed', 'This catch URL tab is closed.');
    return view;
  }

  private isOpen(view: View): boolean {
    return this.views.get(view.id) === view;
  }

  private viewsIn(url: string, workspaceId: string): View[] {
    return [...this.views.values()].filter((view) => view.url === url && view.workspaceId === workspaceId);
  }

  private page(ref: HookRef, page: Page): Promise<CaptureSummary[]> {
    return withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.listCaptures(origin, token, ref.workspaceId, ref.hookId, page),
    );
  }

  private track(work: Promise<void>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  /**
   * Runs `task` after everything already queued on `view` has settled (or immediately, if nothing
   * is), and returns its result. `view.queue` clears back to `undefined` as soon as `run` settles, so
   * the *next* call sees an idle view the moment this one is done, not one extra microtask later.
   * That is what keeps this equivalent to calling `task` directly when the view is idle: a failing
   * task still lets the next one start, so one failed reload cannot wedge a view's fill forever.
   */
  private enqueue<T>(view: View, task: () => Promise<T>): Promise<T> {
    const previous = view.queue;
    const run = previous === undefined ? task() : previous.then(task, task);
    view.queue = run;
    run.then(
      () => {
        if (view.queue === run) view.queue = undefined;
      },
      () => {
        if (view.queue === run) view.queue = undefined;
      },
    );
    return run;
  }

  private onLive(url: string, workspaceId: string, event: LiveEvent): void {
    const watch = this.watches.get(watchKey(url, workspaceId));
    if (watch === undefined) return;
    if (event.kind === 'state') {
      const before = watch.state;
      watch.state = event.state;
      if (event.state === 'connected' && before !== undefined && before !== 'connected') {
        // Whatever arrived or changed while the socket was down (§4.1).
        this.deps.emit.changed({ url, workspaceId });
        for (const view of this.viewsIn(url, workspaceId)) this.fill(view);
      }
      return;
    }
    const { message } = event;
    if (message.type === 'capture') {
      this.deps.emit.captured({ url, workspaceId, hookId: message.hookId, captureId: message.captureId });
      for (const view of this.viewsIn(url, workspaceId)) if (view.hookId === message.hookId) this.fill(view);
    } else if (message.type === 'hooks') {
      this.deps.emit.changed({ url, workspaceId });
      for (const view of this.viewsIn(url, workspaceId)) this.reload(view);
    }
  }

  /** Queues a fill round behind whatever the view's queue is already running. */
  private fill(view: View): void {
    if (view.filling) {
      view.again = true;
      return;
    }
    view.filling = true;
    this.track(this.enqueue(view, () => this.fillRounds(view)));
  }

  /**
   * Everything after the newest summary held, {@link GAP_PAGE} at a time until a short page.
   *
   * Runs on the view's own queue (via {@link fill}), so it never overlaps a reload, a clear or
   * `older` for the same view: whichever was asked for first runs to completion, mutating
   * `summaries`/`details`, before this one even starts its own fetch. That is what stops a fill from
   * resurrecting a clear that raced it, losing a capture a reload raced past, or duplicating what a
   * reload already listed.
   *
   * A round that starts on an empty view (no summary to fetch `after`) fetches only the newest
   * {@link GAP_PAGE} and reports it as `replace`, not `prepend` (M3): the view has nothing to prepend
   * onto, and a `replace` with `more` lets the view keep paging further back, the same as a fresh
   * `open` would.
   */
  private async fillRounds(view: View): Promise<void> {
    try {
      do {
        view.again = false;
        const emptyStart = view.summaries.length === 0;
        const fresh: CaptureSummary[] = [];
        for (;;) {
          const after = fresh[0]?.id ?? view.summaries[0]?.id;
          const page = await this.page(view, after === undefined ? { limit: GAP_PAGE } : { after, limit: GAP_PAGE });
          fresh.unshift(...page);
          if (after === undefined || page.length < GAP_PAGE) break;
        }
        if (!this.isOpen(view)) return;
        const deduped = dedupeNewestFirst(fresh);
        if (emptyStart) {
          // Nothing changed: skip the noisy no-op replace of an already-empty view.
          if (deduped.length === 0) continue;
          view.summaries = deduped;
          view.details.clear();
          this.deps.emit.captures({
            viewId: view.id,
            mode: 'replace',
            captures: deduped,
            more: fresh.length === GAP_PAGE,
          });
        } else if (deduped.length > 0) {
          view.summaries = dedupeNewestFirst([...deduped, ...view.summaries]);
          this.deps.emit.captures({ viewId: view.id, mode: 'prepend', captures: deduped });
        }
      } while (view.again);
    } catch (error) {
      if (this.isOpen(view)) this.deps.emit.captures({ viewId: view.id, mode: 'error', error: problemOf(error) });
    } finally {
      view.filling = false;
    }
  }

  /**
   * The first page again: a clear, a delete or a rotate elsewhere may have changed everything. Runs
   * on the view's own queue (behind any fill/older/reload already under way for it), same as
   * {@link fillRounds}.
   */
  private reload(view: View): void {
    this.track(
      this.enqueue(view, async () => {
        try {
          const captures = await this.page(view, { limit: FIRST_PAGE });
          if (!this.isOpen(view)) return;
          const deduped = dedupeNewestFirst(captures);
          view.summaries = deduped;
          view.details.clear();
          this.deps.emit.captures({
            viewId: view.id,
            mode: 'replace',
            captures: deduped,
            more: captures.length === FIRST_PAGE,
          });
        } catch (error) {
          if (this.isOpen(view)) this.deps.emit.captures({ viewId: view.id, mode: 'error', error: problemOf(error) });
        }
      }),
    );
  }
}
