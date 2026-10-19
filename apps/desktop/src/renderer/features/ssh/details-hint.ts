/**
 * The one-time hint for Host details (#594). Picking a host never opens the panel (owner ruling, #586), and on
 * a fresh machine it starts hidden, so the first card picked says where the details are. Once said, or once
 * the panel has been shown or put away by hand, it is not said again on this machine.
 */
import { dismissToast, showToast } from '../../components/toast.js';
import { useEditorsStore } from '../../state/editors.js';
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
  const id = showToast('Host details open from the icon in the right rail.', {
    label: 'Show details',
    onClick: () => {
      useHostsStore.getState().setDetailsOpen(true);
    },
  });
  dismissWhenHostsLeave(id);
}

/**
 * The hint speaks of the Hosts view, so it goes as soon as that is not what is in front (S41): another tab
 * (a terminal the pick opened), a host form, or the details panel itself.
 */
function dismissWhenHostsLeave(id: number): void {
  const activeId = useEditorsStore.getState().activeId;
  const panel = useUiStore.getState().slideOver.hostDetailsOpen;
  const stops: (() => void)[] = [];
  const dismiss = (): void => {
    for (const stop of stops) stop();
    dismissToast(id);
  };
  stops.push(
    useEditorsStore.subscribe((state) => {
      if (state.activeId !== activeId) dismiss();
    }),
    useHostsStore.subscribe((state) => {
      if (state.dialog !== null) dismiss();
    }),
    useUiStore.subscribe((state) => {
      if (state.slideOver.hostDetailsOpen !== panel) dismiss();
    }),
  );
}
