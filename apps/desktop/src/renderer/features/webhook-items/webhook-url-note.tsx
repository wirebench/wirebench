/**
 * The line under a webhook item's URL bar: where a send would actually go.
 *
 * A webhook item has no API, so the URL bar's greyed prefix only ever reads `Target ·` — this
 * line carries the resolved URL itself, and, for a callback whose URL came from a recorded
 * exchange (or fell back to the target because it did not resolve), the note explaining why. When
 * the Webhooks target itself is unset, the line asks for it instead of showing a send destination.
 */
import { Button } from '../../components/button.js';

export interface WebhookUrlNoteProps {
  /** The URL a send would actually go to; absent only when `source` is `missing`. */
  readonly resolvedUrl?: string | undefined;
  /** Where that URL came from — the folder/collection target, a callback, or its fallback. */
  readonly source: 'target' | 'callback' | 'callback-fallback' | 'missing';
  /** The callback's note (`from your last POST /subscriptions (10:42)`, or why it fell back). */
  readonly detail?: string | undefined;
  readonly onOpenSettings: () => void;
}

/** The note line under a webhook item's URL bar. */
export function WebhookUrlNote({ resolvedUrl, source, detail, onOpenSettings }: WebhookUrlNoteProps) {
  if (source === 'missing') {
    return (
      <p className="flex items-center gap-2 border-b border-hairline bg-surface-base px-3 py-1 text-xs text-fg-subtle">
        <span>Set the Webhooks target</span>
        <Button variant="ghost" onClick={onOpenSettings}>
          Settings…
        </Button>
      </p>
    );
  }

  const showsDetail = (source === 'callback' || source === 'callback-fallback') && detail !== undefined;

  return (
    <p className="flex items-center gap-3 border-b border-hairline bg-surface-base px-3 py-1 text-xs text-fg-subtle">
      {resolvedUrl !== undefined && <span className="truncate">→ {resolvedUrl}</span>}
      {showsDetail && <span className="truncate text-fg-faint">ⓘ {detail}</span>}
    </p>
  );
}
