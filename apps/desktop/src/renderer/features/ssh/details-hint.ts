/**
 * The one-time hint for Host details (#594). Picking a host never opens the panel (owner ruling, #586), and on
 * a fresh machine it starts hidden, so the first card picked says where the details are. Once said, or once
 * the panel has been shown or put away by hand, it is not said again on this machine.
 */
import { showToast } from '../../components/toast.js';
import { useUiStore } from '../../state/ui.js';
import { useHostsStore } from './hosts-store.js';

export const DETAILS_HINT_KEY = 'wirebench.ssh.detailsHinted';

export function hintDetailsOnce(storage: Storage = localStorage): void {
  if (useUiStore.getState().slideOver.hostDetailsOpen !== undefined) return;
  try {
    if (storage.getItem(DETAILS_HINT_KEY) !== null) return;
    storage.setItem(DETAILS_HINT_KEY, '1');
  } catch {
    // A blocked storage could not remember the hint, so it is not shown at all rather than on every pick.
    return;
  }
  showToast('Host details open from the icon in the right rail.', {
    label: 'Show details',
    onClick: () => {
      useHostsStore.getState().setDetailsOpen(true);
    },
  });
}
