/**
 * The forward picked in the Port forwarding view, in the right slide-over (where the host details show on the
 * Hosts view): one list of what it runs, where its rule is set and how it started, with the live value shown
 * only where it differs from the rule's, then its forwarding group.
 * Picking a row opens it; the right rail's icon and its close icon put it away.
 */
import { Pencil, Server } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { useEditorsStore } from '../../../state/editors.js';
import { CopyButton, Row, Section } from '../host-details.js';
import { flattenGroups, useHostsStore } from '../hosts-store.js';
import { isNetworkBind, listenAddress, typeWord } from './forward-format.js';
import { askForPort, restartForward, startForward, stopForward } from './forward-actions.js';
import { groupOfRule } from './forward-groups.js';
import { editRule, move, stateOf, whereFrom } from './forward-row.js';
import { isLive, useForwardsStore } from './forwards-store.js';

/** The picked row: its host and rule as `hosts.yaml` resolves them, and what runs of it. */
function usePicked() {
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
  const exists = usePicked() !== undefined;
  return homeInFront && onForwarding && open && exists;
}

export function ForwardDetails() {
  const picked = usePicked();
  const file = useHostsStore((s) => s.file);
  if (picked === undefined) return null;
  const { hostId, ruleId, host, forward, state, startError } = picked;
  const hostName = host?.name ?? hostId;
  const rule = forward?.rule;
  const live = isLive(state);
  const failed = state?.status.state === 'failed';
  const off = forward !== undefined && !forward.enabled && !live;
  const removed = forward === undefined || !forward.enabled || state?.removed === true;
  const shown = stateOf(state);
  const overridePort = state !== undefined && rule !== undefined && state.port !== rule.port ? state.port : undefined;
  // What it listens on now: where it runs, else the address this run asked for.
  const address =
    state?.status.state === 'running'
      ? listenAddress(state.status.listening.address, state.status.listening.port)
      : rule === undefined
        ? undefined
        : listenAddress(rule.bind, overridePort ?? rule.port);
  const error = state?.status.state === 'failed' ? state.status.error.message : startError?.message;
  const groups = flattenGroups(file);
  const groupName = (id: string): string => groups.find(({ group }) => group.id === id)?.group.name ?? id;
  const inGroup = groupOfRule(file, hostId, ruleId);
  const forwardGroupName = (id: string): string => file.forwardGroups?.find((g) => g.id === id)?.name ?? id;
  const started =
    state === undefined
      ? undefined
      : state.group !== undefined
        ? `with group ${forwardGroupName(state.group)}`
        : state.origin === 'auto'
          ? "with the host's terminals"
          : 'by hand';
  const muted = (text: string) => <span className="truncate text-xs text-fg-subtle">{text}</span>;

  const openHost = (): void => {
    const hosts = useHostsStore.getState();
    hosts.setHomeView('hosts');
    hosts.selectHost(hostId);
  };

  return (
    <div data-testid="forward-details" className="flex flex-col">
      <div className="flex flex-col gap-3 px-1 py-3">
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate text-md font-medium text-fg-default">{ruleId}</h2>
          <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
            <span
              className={`size-2 shrink-0 rounded-full bg-current ${off ? 'text-fg-faint' : shown.color}`}
              aria-hidden="true"
            />
            <span data-testid="forward-details-state">{off ? 'off' : shown.label}</span>
            <span className="truncate">· {hostName}</span>
          </p>
        </div>
        {!off && (
          <div className="flex flex-wrap items-center gap-2">
            {live || (removed && state !== undefined) ? (
              <Button
                onClick={() => {
                  void stopForward(hostId, ruleId);
                }}
              >
                Stop
              </Button>
            ) : removed ? null : (
              <Button
                variant="primary"
                onClick={() => {
                  void startForward(hostId, ruleId);
                }}
              >
                {failed ? 'Retry' : 'Start'}
              </Button>
            )}
            {state?.changed === true && live && !removed && (
              <Button
                onClick={() => {
                  void restartForward(hostId, ruleId);
                }}
              >
                Restart
              </Button>
            )}
            {!removed && !live && (
              <Button
                onClick={() => {
                  void askForPort(hostId, ruleId);
                }}
              >
                Another port…
              </Button>
            )}
            {forward !== undefined && (
              <Button
                className="ml-auto"
                onClick={() => {
                  editRule(hostId, forward.from);
                }}
              >
                <Pencil size={12} aria-hidden="true" /> Edit rule
              </Button>
            )}
          </div>
        )}
      </div>
      {!off && error !== undefined && (
        <p
          role="alert"
          className="mx-1 mb-3 rounded-md border border-status-danger px-3 py-2 text-sm break-words text-fg-default"
        >
          {error}
        </p>
      )}
      <Section title="Forward">
        {rule === undefined ? (
          <Row label="Rule">{muted('removed from hosts.yaml since it started')}</Row>
        ) : (
          <>
            <Row label="Type">
              <span>{typeWord(rule.type)}</span>
              {muted(rule.type === 'remote' ? 'listens on the host' : 'listens on this machine')}
            </Row>
            <Row label="Listens on">
              <span className="truncate font-mono">{address}</span>
              {address !== undefined && <CopyButton text={address} label="Copy address" />}
              {overridePort !== undefined && muted(`this run; the rule says ${String(rule.port)}`)}
            </Row>
            <Row label="Target">
              {rule.target === undefined ? (
                <span className="text-fg-subtle">SOCKS5, any destination through the host</span>
              ) : (
                <span className="truncate font-mono">{listenAddress(rule.target.host, rule.target.port)}</span>
              )}
            </Row>
            {started === undefined ? (
              <Row label="Starts">
                <span>{rule.autoStart ? "with the host's terminals" : 'by hand'}</span>
              </Row>
            ) : (
              <Row label="Started">
                <span data-testid="forward-details-started">{started}</span>
                {rule.autoStart && state?.origin !== 'auto' && muted("the rule starts with the host's terminals")}
              </Row>
            )}
            {isNetworkBind(rule.bind) && (
              <Row label="Reach">
                <span className="text-status-danger">other machines can connect</span>
              </Row>
            )}
          </>
        )}
        {state?.changed === true && (
          <Row label="Changed">{muted('since it started: Restart runs it as the rule now is')}</Row>
        )}
        <Row label="Host">
          <span className="truncate">{hostName}</span>
          {host !== undefined && (
            <Button className="ml-auto h-6 px-2 text-xs" onClick={openHost}>
              <Server size={12} aria-hidden="true" /> Open host
            </Button>
          )}
        </Row>
        {forward !== undefined && host !== undefined && (
          <Row label="Set on">
            <span>
              {forward.enabled
                ? whereFrom(forward.from, host, groupName)
                : `off on ${whereFrom(forward.offBy ?? forward.from, host, groupName)}`}
            </span>
          </Row>
        )}
      </Section>
      {forward !== undefined && (
        <Section title="Forwarding group">
          <Row label="Group">
            <select
              aria-label="Forwarding group"
              className="min-w-0 flex-1 rounded-md border border-hairline-strong bg-surface-base px-2 py-1 text-sm text-fg-default"
              value={inGroup?.id ?? ''}
              onChange={(event) => {
                move(hostId, ruleId, event.target.value === '' ? undefined : event.target.value);
              }}
            >
              <option value="">Ungrouped</option>
              {(file.forwardGroups ?? []).map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </Row>
        </Section>
      )}
    </div>
  );
}
