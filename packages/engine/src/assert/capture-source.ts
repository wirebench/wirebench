/**
 * Where a callback assertion reads captures from (callback-assertion spec §2.2). The engine never
 * talks to a server: a host (the desktop's main process, the CLI) hands a run a `CaptureSource`.
 * `captureSourceOver` builds one from the three reads of the webhook-capture manage API, so the two
 * hosts share the paging, the oldest-first order and the decoding, and differ only in how they
 * authenticate.
 */
import { WirebenchError } from '../errors.js';
import { HOOKS_LIMITS } from '../server-api/hooks.js';
import type { Capture, CaptureSummary, CatchUrl } from '../server-api/hooks.js';

export interface CaptureSummaryView {
  /** A ULID: sorts by arrival. */
  readonly id: string;
  readonly receivedAt: string;
  readonly method: string;
  /** The decoded subpath: `/` when the sender posted to the catch URL itself. */
  readonly path: string;
  readonly signature: { readonly verdict: 'verified' | 'failed'; readonly reason?: string } | null;
}

export interface CaptureDetailView extends CaptureSummaryView {
  readonly headers: readonly (readonly [string, string])[];
  /** UTF-8 decoded; a truncated capture carries what was kept. */
  readonly bodyText: string;
  readonly truncated: boolean;
}

export interface CaptureSource {
  /** Resolves a catch URL name; `undefined` when the workspace has none by that name. */
  resolve(catchUrl: string): Promise<{ readonly hookId: string } | undefined>;
  /** The newest capture's id now, or `null` when there is none. Taken before the send. */
  cursor(hookId: string): Promise<string | null>;
  /** Captures after the cursor, oldest first. */
  after(hookId: string, cursor: string | null): Promise<readonly CaptureSummaryView[]>;
  detail(hookId: string, captureId: string): Promise<CaptureDetailView>;
}

/** The manage API reads a host performs for one workspace, with its own credentials. */
export interface CaptureServerReads {
  /** `GET …/hooks`. */
  hooks(): Promise<readonly Pick<CatchUrl, 'id' | 'name'>[]>;
  /** `GET …/hooks/:hookId/captures?after=&limit=`: newest first, as the server answers. */
  captures(
    hookId: string,
    page: { readonly after?: string; readonly limit: number },
  ): Promise<readonly CaptureSummary[]>;
  /** `GET …/hooks/:hookId/captures/:captureId`. */
  capture(hookId: string, captureId: string): Promise<Capture>;
}

/** Below every ULID: `after` from here reads a hook's captures from its first. */
export const FIRST_CAPTURE_CURSOR = '00000000000000000000000000';

/** A wait never reads more than this many pages of 200 per poll: a flood is not worth following. */
const MAX_PAGES_PER_POLL = 25;

function decodedPath(subpath: string): string {
  const path = subpath === '' ? '/' : subpath;
  try {
    return decodeURIComponent(path);
  } catch {
    // A sender's malformed escape stays as it arrived: `path` then compares against what was sent.
    return path;
  }
}

export function captureSummaryView(summary: CaptureSummary): CaptureSummaryView {
  const signature = summary.signature ?? null;
  return {
    id: summary.id,
    receivedAt: summary.receivedAt,
    method: summary.method,
    path: decodedPath(summary.subpath),
    signature:
      signature === null
        ? null
        : { verdict: signature.verdict, ...(signature.reason !== undefined ? { reason: signature.reason } : {}) },
  };
}

export function captureDetailView(capture: Capture): CaptureDetailView {
  return {
    ...captureSummaryView(capture),
    headers: capture.headers,
    bodyText: Buffer.from(capture.body, 'base64').toString('utf8'),
    truncated: capture.truncated,
  };
}

/** A `CaptureSource` over the manage API. The hook list is read once per source, which is once per run. */
export function captureSourceOver(reads: CaptureServerReads): CaptureSource {
  let hooks: Promise<readonly Pick<CatchUrl, 'id' | 'name'>[]> | undefined;
  return {
    async resolve(catchUrl) {
      hooks ??= reads.hooks();
      let list: readonly Pick<CatchUrl, 'id' | 'name'>[];
      try {
        list = await hooks;
      } catch (error) {
        hooks = undefined; // the next assertion asks again
        throw error;
      }
      const wanted = catchUrl.trim().toLowerCase();
      const found = list.find((hook) => hook.name.trim().toLowerCase() === wanted);
      return found === undefined ? undefined : { hookId: found.id };
    },
    async cursor(hookId) {
      const [newest] = await reads.captures(hookId, { limit: 1 });
      return newest?.id ?? null;
    },
    async after(hookId, cursor) {
      const out: CaptureSummaryView[] = [];
      let from = cursor ?? FIRST_CAPTURE_CURSOR;
      for (let page = 0; page < MAX_PAGES_PER_POLL; page += 1) {
        const newestFirst = await reads.captures(hookId, { after: from, limit: HOOKS_LIMITS.maxPageSize });
        const oldestFirst = [...newestFirst].reverse();
        out.push(...oldestFirst.map(captureSummaryView));
        const last = oldestFirst.at(-1);
        if (last === undefined || newestFirst.length < HOOKS_LIMITS.maxPageSize) break;
        from = last.id;
      }
      return out;
    },
    async detail(hookId, captureId) {
      return captureDetailView(await reads.capture(hookId, captureId));
    },
  };
}

/** A source for a host that cannot read captures: every callback assertion errors with `message`. */
export function unavailableCaptureSource(message: string): CaptureSource {
  const refuse = (): Promise<never> => Promise.reject(new WirebenchError('callback-source-unavailable', message));
  return { resolve: refuse, cursor: refuse, after: refuse, detail: refuse };
}
