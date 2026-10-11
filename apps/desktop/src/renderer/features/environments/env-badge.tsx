import { Lock } from 'lucide-react';
import { environmentColorCss } from '../../../shared/environment-colors.js';

/**
 * An environment's colour dot and protected lock (#345), as the switcher shows them beside its
 * name. Renders nothing for an environment with neither.
 */
export function EnvBadge({ color, guarded }: { readonly color: string | undefined; readonly guarded: boolean }) {
  const css = environmentColorCss(color);
  return (
    <>
      {css !== undefined && (
        <span
          data-testid="env-color-dot"
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full bg-[var(--env-color)]"
          style={{ '--env-color': css } as React.CSSProperties}
        />
      )}
      {guarded && (
        <Lock size={11} role="img" aria-label="Protected environment" className="shrink-0 text-status-warning" />
      )}
    </>
  );
}
