/**
 * The streaming-shape badge that precedes a gRPC request's name in the explorer and in the editor:
 * the gRPC counterpart of the REST method badge, in the same fixed column and the same typographic
 * weight, so a project mixing the two protocols reads as one tree.
 */
import type { GrpcMethodKindWire } from '../../../shared/wire-types.js';

/** The label each streaming shape shows in full. */
const FULL_LABEL: Readonly<Record<GrpcMethodKindWire, string>> = {
  unary: 'Unary',
  'server-streaming': 'Server streaming',
  'client-streaming': 'Client streaming',
  'bidi-streaming': 'Bidirectional streaming',
};

/**
 * The short forms the explorer's narrow column uses: the direction arrows are the one thing that
 * differs between the four shapes, so they are what the badge spells out.
 */
const COMPACT_LABEL: Readonly<Record<GrpcMethodKindWire, string>> = {
  unary: 'RPC',
  'server-streaming': 'RPC↓',
  'client-streaming': 'RPC↑',
  'bidi-streaming': 'RPC↕',
};

/** One method kind as the badge spells it, in full or compact form. */
export function methodKindLabel(kind: GrpcMethodKindWire, compact = false): string {
  return compact ? COMPACT_LABEL[kind] : FULL_LABEL[kind];
}

export interface MethodKindBadgeProps {
  readonly kind: GrpcMethodKindWire;
  /** Spells the shape short, for the explorer's fixed-width column. */
  readonly compact?: boolean;
  readonly className?: string;
}

/** One streaming-shape badge. */
export function MethodKindBadge({ kind, compact = false, className }: MethodKindBadgeProps) {
  return (
    <span
      data-testid="method-kind-badge"
      data-method-kind={kind}
      title={FULL_LABEL[kind]}
      className={`shrink-0 font-mono ${compact ? 'text-2xs' : 'text-xs'} font-bold leading-none text-method-other ${className ?? ''}`}
    >
      {methodKindLabel(kind, compact)}
    </span>
  );
}
