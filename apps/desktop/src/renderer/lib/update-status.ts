import { useEffect, useState } from 'react';
import { showToast } from '../components/toast.js';
import { ipc } from '../state/ipc-client.js';
import type { AppUpdateStatus, UpdateStatusWire } from '../../shared/wire-types.js';

/**
 * How each update status reads to the user, or `undefined` where there is nothing worth
 * saying — `checking` and `downloading` are progress, which the status bar shows on its own,
 * and `installing` is immediately followed by the app restarting.
 */
export function updateStatusMessage(status: UpdateStatusWire): string | undefined {
  switch (status.kind) {
    case 'up-to-date':
      return 'Wirebench is up to date';
    case 'busy':
      return 'An update check is already running';
    case 'declined':
      return `Wirebench ${status.version} was not downloaded`;
    case 'downloaded':
      return `Wirebench ${status.version} is ready — install it from Check for Updates`;
    case 'error':
      return status.message;
    default:
      return undefined;
  }
}

/** The short label the status bar shows while a check or download is in flight. */
export function updateStatusLabel(status: UpdateStatusWire | undefined): string | undefined {
  if (status?.kind === 'checking') {
    return 'Checking for updates…';
  }
  if (status?.kind === 'downloading') {
    return `Downloading update ${status.percent}%`;
  }
  return undefined;
}

/** Runs one update check and reports the outcome as a toast. The `app.checkForUpdates` command. */
export async function checkForUpdates(): Promise<void> {
  const result = await ipc().app.checkForUpdates(undefined);
  const message = result.ok ? updateStatusMessage(result.value.status) : 'Could not check for updates';
  if (message !== undefined) {
    showToast(message);
  }
}

/**
 * The latest `app.updateStatus` main broadcast, for the status bar. Progress only: a finished
 * check reports itself as a toast, and permanent chrome should not keep an error on screen.
 */
export function useUpdateStatus(): UpdateStatusWire | undefined {
  const [status, setStatus] = useState<UpdateStatusWire>();

  useEffect(
    () =>
      // `defineEvent` types every event's `name` as `string`, so the derived event map cannot
      // narrow a payload by channel; the cast is the same one the other event mirrors use.
      ipc().on('app.updateStatus', ((payload: AppUpdateStatus) => {
        setStatus(payload.status);
      }) as (payload: unknown) => void),
    [],
  );

  return status;
}
