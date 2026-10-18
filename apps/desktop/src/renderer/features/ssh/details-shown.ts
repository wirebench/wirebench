/**
 * Whether the host and forward details are in front, apart from the panels themselves: the shell and
 * the right rail ask on every render, while the panels load only once one of them shows.
 */
import { useEditorsStore } from '../../state/editors.js';
import { useUiStore } from '../../state/ui.js';
import { useForwardsStore } from './forwarding/forwards-store.js';
import { useHostsStore } from './hosts-store.js';

/**
 * Whether the details slide-over is in front: the Hosts tab is showing and the panel was not put away,
 * or New host borrows it (whether it shows otherwise stays as the user left it). With no host picked
 * (after a restart, say) it still shows, and asks for one.
 */
export function useHostDetailsShown(): boolean {
  const homeInFront = useEditorsStore((s) => s.displayedSet === 'ssh' && s.activeId === undefined);
  const onHosts = useHostsStore((s) => s.homeView === 'hosts');
  const open = useUiStore((s) => s.slideOver.hostDetailsOpen === true);
  const newHost = useHostsStore((s) => s.dialog?.mode === 'new-host');
  return homeInFront && onHosts && (open || newHost);
}

/** The picked forward row: its host and rule as `hosts.yaml` resolves them, and what runs of it. */
export function usePickedForward() {
  const key = useForwardsStore((s) => s.selectedKey);
  const state = useForwardsStore((s) => (key === undefined ? undefined : s.byKey[key]));
  const startError = useForwardsStore((s) => (key === undefined ? undefined : s.startErrors[key]));
  const resolved = useHostsStore((s) => s.resolved);
  if (key === undefined) return undefined;
  const [hostId = '', ruleId = ''] = key.split('/');
  const host = resolved.find((h) => h.id === hostId);
  const forward = host?.forwards.find((f) => f.rule.id === ruleId);
  // A forward still running after its rule (or host) left the file stays pickable, so it can be stopped.
  if (forward === undefined && state === undefined) return undefined;
  return { hostId, ruleId, host, forward, state, startError };
}

/** Whether the forward details are in front: the Port forwarding view shows, a row is picked, not put away. */
export function useForwardDetailsShown(): boolean {
  const homeInFront = useEditorsStore((s) => s.displayedSet === 'ssh' && s.activeId === undefined);
  const onForwarding = useHostsStore((s) => s.homeView === 'forwarding');
  const open = useForwardsStore((s) => s.detailsOpen);
  const exists = usePickedForward() !== undefined;
  return homeInFront && onForwarding && open && exists;
}
