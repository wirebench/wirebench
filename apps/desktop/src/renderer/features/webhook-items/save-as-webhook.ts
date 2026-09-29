/**
 * *Save as webhook…* (Task 15): turns one captured request into a webhook item's draft. Pure
 * mapping, no store and no IPC, so the dialog can call it synchronously while the user is still
 * choosing where the new item goes.
 *
 * `rememberCapture`/`captureFor` are the bridge from the catch-URL tab, which already holds the
 * `CaptureViewWire` it fetched to show in the viewer, to the dialog, which only gets a capture id
 * through `webhook-items-state.ts`'s `saveAs` slot: fetching the capture again would need its
 * `viewId`, which only the tab that opened it still has. The dialog reads back whatever the tab
 * last showed; if that capture is gone (the tab closed, or moved on to another one), it has
 * nothing to read and says so.
 */
import type { CaptureViewWire, KeyValueWire, RestBodyWire, RestRequestPatchWire } from '../../../shared/wire-types.js';

let lastCapture: CaptureViewWire | undefined;

export function rememberCapture(capture: CaptureViewWire): void {
  lastCapture = capture;
}

export function captureFor(captureId: string): CaptureViewWire | undefined {
  return lastCapture?.id === captureId ? lastCapture : undefined;
}

const DROPPED_EXACT: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'forwarded',
  'x-request-id',
]);

/** The Global Constraints drop list: transport, proxy, forwarding and signature headers. */
export function droppedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    DROPPED_EXACT.has(lower) ||
    lower.startsWith('proxy-') ||
    lower.startsWith('x-forwarded-') ||
    lower.includes('signature')
  );
}

/** The event's own `type`, when the body is a JSON object that names one; else method and path. */
function nameOf(capture: CaptureViewWire): string {
  const path = capture.subpath === '' ? '/' : capture.subpath;
  if (capture.language === 'json') {
    try {
      const parsed: unknown = JSON.parse(capture.text);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof (parsed as { type?: unknown }).type === 'string' &&
        (parsed as { type: string }).type !== ''
      ) {
        return (parsed as { type: string }).type;
      }
    } catch {
      // Not valid JSON despite the language tag; fall through to the method-and-path name.
    }
  }
  return `${capture.method} ${path}`;
}

export type SaveAsWebhookResult =
  | { readonly ok: true; readonly name: string; readonly draft: RestRequestPatchWire }
  | { readonly ok: false; readonly code: 'webhook-save-truncated' | 'webhook-save-binary'; readonly message: string };

export function saveAsWebhookDraft(capture: CaptureViewWire): SaveAsWebhookResult {
  if (capture.truncated) {
    return {
      ok: false,
      code: 'webhook-save-truncated',
      message: "The body was cut at the server's limit, so it cannot be replayed.",
    };
  }
  if (capture.language === 'binary' || capture.language === 'image') {
    return { ok: false, code: 'webhook-save-binary', message: 'A binary body cannot be saved as a webhook.' };
  }

  const headers: KeyValueWire[] = capture.headers
    .filter(([name]) => !droppedHeader(name))
    .map(([name, value]) => ({ name, value, enabled: true }));

  const isForm = capture.contentType?.split(';')[0]?.trim().toLowerCase() === 'application/x-www-form-urlencoded';
  const body: RestBodyWire =
    capture.text === ''
      ? { kind: 'none' }
      : isForm
        ? {
            kind: 'form',
            fields: [...new URLSearchParams(capture.text)].map(([name, value]) => ({ name, value, enabled: true })),
          }
        : { kind: 'raw', language: capture.language, text: capture.text };

  const path = capture.subpath === '' ? '/' : capture.subpath;
  return {
    ok: true,
    name: nameOf(capture),
    draft: {
      method: capture.method,
      url: capture.query === '' ? path : `${path}?${capture.query}`,
      headers,
      body,
    },
  };
}
