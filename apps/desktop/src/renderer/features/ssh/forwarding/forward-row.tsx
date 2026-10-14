import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '../../../components/button.js';
import type { ForwardStateWire } from '../../../../shared/forward-wire.js';
import type { ResolvedForwardWire, ResolvedHostWire } from '../../../../shared/ssh-wire.js';
import { useUiStore } from '../../../state/ui.js';
import { editHost } from '../connect.js';
import { useHostsStore } from '../hosts-store.js';
import { isNetworkBind, levelName, listenAddress, routeOf, typeLetter } from './forward-format.js';
import { askForPort, restartForward, startForward, stopForward } from './forward-actions.js';
import { isLive, type ForwardStartError } from './forwards-store.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent-muted';
const CONTENT_CLASS = 'z-dropdown min-w-44 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg';
const BADGE_CLASS = 'shrink-0 rounded-full border px-1.5 text-[10px] leading-4';

/** The state a row shows: what main reports, else stopped. */
function stateOf(state: ForwardStateWire | undefined): { label: string; color: string } {
  switch (state?.status.state) {
    case 'starting':
      return { label: 'starting', color: 'text-status-warning' };
    case 'running': {
      const n = state.status.connections;
      return {
        label: `running · ${String(n)} ${n === 1 ? 'connection' : 'connections'}`,
        color: 'text-status-success',
      };
    }
    case 'reconnecting':
      return { label: `reconnecting (attempt ${String(state.status.attempt)})`, color: 'text-status-warning' };
    case 'failed':
      return { label: 'failed', color: 'text-status-danger' };
    default:
      return { label: 'stopped', color: 'text-fg-faint' };
  }
}

/** Opens the editor of the level a rule is written on: the host's details form, or its group's dialog. */
function editRule(hostId: string, from: ResolvedForwardWire['from']): void {
  if (from === 'host') {
    editHost(hostId);
    return;
  }
  // The group dialog lives in the SSH sidebar's view.
  const { sidebar, showSidebarView } = useUiStore.getState();
  if (!sidebar.visible || sidebar.view !== 'ssh') showSidebarView('ssh');
  useHostsStore.getState().openDialog({ mode: 'edit-group', id: from.group });
}

export interface ForwardRowProps {
  readonly host: Pick<ResolvedHostWire, 'id' | 'name'>;
  /** The rule as `hosts.yaml` resolves it now; absent for a forward still running whose rule was removed. */
  readonly forward: ResolvedForwardWire | undefined;
  readonly ruleId: string;
  readonly state: ForwardStateWire | undefined;
  readonly startError: ForwardStartError | undefined;
  readonly groupName: (id: string) => string;
  /** The Port forwarding view names the host; the host's own panel does not. */
  readonly showHost?: boolean;
}

/**
 * One forwarding rule: its state, type, `bind:port → target`, where it came from, its `auto` and network
 * badges and what can be done with it. An off rule is greyed with the level that switched it off and offers
 * nothing; a forward whose rule was removed or switched off while it ran offers Stop only.
 */
export function ForwardRow({ host, forward, ruleId, state, startError, groupName, showHost = true }: ForwardRowProps) {
  const rule = forward?.rule;
  const live = isLive(state);
  const failed = state?.status.state === 'failed';
  // A rule switched off while its forward runs still needs its Stop.
  const off = forward !== undefined && !forward.enabled && !live;
  const removed = forward === undefined || !forward.enabled || state?.removed === true;
  const shown = stateOf(state);
  const port = state?.port ?? rule?.port;
  const error = state?.status.state === 'failed' ? state.status.error.message : startError?.message;
  const overridePort = state !== undefined && rule !== undefined && state.port !== rule.port ? state.port : undefined;
  const address =
    state?.status.state === 'running'
      ? listenAddress(state.status.listening.address, state.status.listening.port)
      : rule === undefined || port === undefined
        ? undefined
        : listenAddress(rule.bind, port);

  const start = (): void => {
    void startForward(host.id, ruleId, overridePort === undefined ? {} : { port: overridePort });
  };
  const stop = (): void => {
    void stopForward(host.id, ruleId);
  };

  return (
    <li
      data-testid="forward-row"
      data-forward={`${host.id}/${ruleId}`}
      data-state={off ? 'off' : (state?.status.state ?? 'idle')}
      aria-disabled={off || undefined}
      className={`flex flex-col gap-0.5 px-3 py-2 ${off ? 'opacity-50' : ''}`}
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span
          role="img"
          aria-label={off ? 'off' : shown.label}
          title={off ? 'off' : shown.label}
          className={`size-2 shrink-0 rounded-full bg-current ${off ? 'text-fg-faint' : shown.color}`}
        />
        <span className="shrink-0 font-medium text-fg-default">{ruleId}</span>
        {rule !== undefined && (
          <span
            title={rule.type}
            className="shrink-0 rounded border border-hairline px-1 font-mono text-[10px] text-fg-subtle"
          >
            {typeLetter(rule.type)}
          </span>
        )}
        {rule !== undefined && (
          <span className="min-w-0 truncate font-mono text-xs text-fg-default">{routeOf(rule, port)}</span>
        )}
        {showHost && <span className="shrink-0 truncate text-xs text-fg-muted">{host.name}</span>}
        <span className="min-w-0 truncate text-xs text-fg-subtle">
          {forward === undefined
            ? 'removed from hosts.yaml'
            : !forward.enabled
              ? `off on ${levelName(forward.offBy ?? forward.from, host, groupName)}`
              : `from ${levelName(forward.from, host, groupName)}`}
        </span>
        {rule?.autoStart === true && !off && (
          <span title="Starts with the host's terminals" className={`${BADGE_CLASS} border-hairline text-fg-subtle`}>
            auto
          </span>
        )}
        {rule !== undefined && isNetworkBind(rule.bind) && (
          <span
            title={`Reachable from other machines at ${listenAddress(rule.bind, port ?? rule.port)}`}
            className={`${BADGE_CLASS} border-status-danger text-status-danger`}
          >
            network
          </span>
        )}
        {!off && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {state?.changed === true && !removed && live && (
              <Button
                className="h-6 px-2 text-xs"
                onClick={() => {
                  void restartForward(host.id, ruleId);
                }}
              >
                Restart
              </Button>
            )}
            {live || (removed && state !== undefined) ? (
              <Button className="h-6 px-2 text-xs" onClick={stop}>
                Stop
              </Button>
            ) : removed ? null : failed ? (
              <Button className="h-6 px-2 text-xs" onClick={start}>
                Retry
              </Button>
            ) : (
              <Button variant="primary" className="h-6 px-2 text-xs" onClick={start}>
                Start
              </Button>
            )}
            {forward !== undefined && !removed && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    aria-label={`More actions for ${ruleId}`}
                    className="inline-flex size-6 items-center justify-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg-default"
                  >
                    <MoreHorizontal size={14} aria-hidden="true" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content align="end" className={CONTENT_CLASS}>
                    <DropdownMenu.Item
                      className={ITEM_CLASS}
                      disabled={live}
                      onSelect={() => {
                        void askForPort(host.id, ruleId);
                      }}
                    >
                      Start on another port…
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className={ITEM_CLASS}
                      disabled={address === undefined}
                      onSelect={() => {
                        if (address !== undefined) void navigator.clipboard.writeText(address);
                      }}
                    >
                      Copy address
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className={ITEM_CLASS}
                      onSelect={() => {
                        editRule(host.id, forward.from);
                      }}
                    >
                      Edit rule
                    </DropdownMenu.Item>
                    <DropdownMenu.Item className={ITEM_CLASS} disabled={state === undefined} onSelect={stop}>
                      Stop
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
          </span>
        )}
      </div>
      {!off && (live || failed) && (
        <p data-testid="forward-state" className="truncate pl-4 text-xs text-fg-subtle">
          {shown.label}
        </p>
      )}
      {!off && error !== undefined && (
        <p role="alert" className="pl-4 text-xs break-words text-status-danger">
          {error}
        </p>
      )}
    </li>
  );
}
