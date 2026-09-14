import { useEffect, useRef, useState } from 'react';
import { useSyncStore } from '../../state/sync.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { SyncPulledEvent } from '../../../shared/wire-types.js';
import { remoteHost } from './remote-host.js';

/** How long the pulled notice stays up before it dismisses itself. */
const PULLED_NOTICE_MS = 8_000;

/** The classes {@link ChangedOnDiskBanner} uses for its container and its two buttons, cloned
 * here so the sync banner reads as the same kind of notice. */
const CONTAINER_CLASS =
  'flex shrink-0 items-center gap-3 border-b border-hairline bg-surface-sunken px-3 py-1.5 text-sm text-fg-default';
const PRIMARY_BUTTON_CLASS =
  'shrink-0 rounded border border-hairline-strong px-2 py-0.5 text-xs hover:bg-surface-raised';
const SECONDARY_BUTTON_CLASS = 'shrink-0 rounded px-2 py-0.5 text-xs text-fg-subtle hover:bg-surface-raised';

/** One pulled notice's transient content — cleared 8s after it arrives, or on dismiss. */
interface PulledNotice {
  readonly entityCount: number;
}

/**
 * The sync banner: a transient notice for the last pull (Task 11's "pulled changes notice"), and
 * a standing call to action while the open workspace has unresolved conflicts. Mounted once,
 * directly under `ChangedOnDiskBanner`, above the editor tabs.
 */
export function SyncBanner() {
  const remote = useSyncStore((state) => state.status.remote);
  const conflicts = useSyncStore((state) => state.conflicts);
  const setConflictResolverOpen = useUiStore((state) => state.setConflictResolverOpen);
  const [pulled, setPulled] = useState<PulledNotice | undefined>(undefined);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const off = window.wirebench.on('sync.pulled', ((payload: SyncPulledEvent) => {
      if (payload.workspaceId !== useWorkspaceStore.getState().workspace?.id) {
        return;
      }
      setPulled({ entityCount: payload.entityCount });
    }) as (payload: unknown) => void);
    return off;
  }, []);

  useEffect(() => {
    if (pulled === undefined) {
      return;
    }
    dismissTimer.current = setTimeout(() => {
      setPulled(undefined);
    }, PULLED_NOTICE_MS);
    return () => {
      clearTimeout(dismissTimer.current);
    };
  }, [pulled]);

  if (pulled === undefined && conflicts.length === 0) {
    return null;
  }

  const host = remoteHost(remote);
  const changeWord = pulled?.entityCount === 1 ? 'change' : 'changes';
  const pulledText =
    pulled === undefined
      ? ''
      : host === undefined
        ? `Pulled ${String(pulled.entityCount)} ${changeWord}.`
        : `Pulled ${String(pulled.entityCount)} ${changeWord} from ${host}.`;

  return (
    <>
      {pulled !== undefined && (
        <div role="status" data-testid="sync-banner-pulled" className={CONTAINER_CLASS}>
          <span className="min-w-0 flex-1 truncate">{pulledText}</span>
          <button
            type="button"
            data-testid="sync-banner-pulled-dismiss"
            onClick={() => {
              setPulled(undefined);
            }}
            className={SECONDARY_BUTTON_CLASS}
          >
            Dismiss
          </button>
        </div>
      )}
      {conflicts.length > 0 && (
        <div role="status" data-testid="sync-banner-conflicts" className={CONTAINER_CLASS}>
          <span className="min-w-0 flex-1 truncate">
            {conflicts.length} {conflicts.length === 1 ? 'conflict needs' : 'conflicts need'} resolving.
          </span>
          <button
            type="button"
            data-testid="sync-banner-resolve"
            onClick={() => {
              setConflictResolverOpen(true);
            }}
            className={PRIMARY_BUTTON_CLASS}
          >
            Resolve…
          </button>
        </div>
      )}
    </>
  );
}
