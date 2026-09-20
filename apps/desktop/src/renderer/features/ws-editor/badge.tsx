/**
 * The **WS** badge that precedes a WebSocket request's name in the explorer: the WebSocket
 * counterpart of the REST method badge and the gRPC streaming-shape badge, in the same fixed
 * column and the same typographic weight, so a project mixing protocols reads as one tree.
 */

export interface WsBadgeProps {
  readonly className?: string;
}

/** The one WebSocket request badge — every WebSocket request is the same kind of thing. */
export function WsBadge({ className }: WsBadgeProps) {
  return (
    <span
      data-testid="ws-badge"
      title="WebSocket"
      className={`shrink-0 font-mono text-2xs font-bold leading-none text-method-other ${className ?? ''}`}
    >
      WS
    </span>
  );
}
