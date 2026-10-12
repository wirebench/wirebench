import { Shield } from 'lucide-react';

/** The small shield on a protected host (`protected: true` on it or a group above it): runs on it always ask. */
export function ProtectedMark({ size = 12 }: { readonly size?: number }) {
  return (
    <span
      role="img"
      aria-label="Protected"
      title="Protected: snippet runs on this host always ask first"
      className="inline-flex shrink-0 text-status-warning"
    >
      <Shield size={size} aria-hidden="true" />
    </span>
  );
}
