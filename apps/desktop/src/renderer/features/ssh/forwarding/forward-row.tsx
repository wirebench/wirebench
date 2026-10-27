import type { DragEvent, KeyboardEvent, MouseEvent } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { showToast } from '../../../components/toast.js';
import type { ForwardStateWire } from '@shared/forward-wire.js';
import type { ResolvedForwardWire, ResolvedHostWire } from '@shared/ssh-wire.js';
import { useUiStore } from '../../../state/ui.js';
import { editHost } from '../connect.js';
import { useHostsStore } from '../hosts-store.js';
import { isNetworkBind, levelName, listenAddress, routeOf, typeWord } from './forward-format.js';
import { askForPort, restartForward, startForward, stopForward } from './forward-actions.js';
import { FORWARD_DRAG_TYPE, groupOfRule, moveRule, saveGroups } from './forward-groups.js';
import { isLive, type ForwardStartError } from './forwards-store.js';

export const ITEM_CLASS =
  'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent-muted';
export const CONTENT_CLASS = 'z-dropdown min-w-44 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg';
const BADGE_CLASS = 'shrink-0 rounded-full border px-1.5 text-[10px] leading-4';

/** The state a row shows: what main reports, else stopped. */
export function stateOf(state: ForwardStateWire | undefined): { label: string; color: string } {
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
export function editRule(hostId: string, from: ResolvedForwardWire['from']): void {
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
  /** The forwarding group the row is listed under: a member whose rule has gone offers to leave it. */
  readonly forwardGroupId?: string;
  /** "New group…" under Move to group, which asks for a name; absent where it cannot be asked. */
  readonly onNewGroup?: (hostId: string, ruleId: string) => void;
  /** Makes the row pickable: a click picks it, and its details show on the right. */
  readonly onSelect?: (key: string) => void;
  /** The picked row, highlighted. */
  readonly selected?: boolean;
  /** Makes the row draggable onto the view's group sections; told the key while it is dragged. */
  readonly onDragChange?: (key: string | undefined) => void;
}

/** Saves a rule's move into a forwarding group, or out of every group, toasting a refusal. */
export function move(hostId: string, ruleId: string, toGroupId: string | undefined): void {
  void saveGroups(moveRule(useHostsStore.getState().file, hostId, ruleId, toGroupId)).then((problem) => {
    if (problem !== undefined) showToast(problem);
  });
}

/**
 * "this host" or "host group Production": a rule named like its host no longer reads "db from db", and a host
 * group is never mistaken for a forwarding group.
 */
export function whereFrom(
  level: ResolvedForwardWire['from'],
  host: Pick<ResolvedHostWire, 'name'>,
  groupName: (id: string) => string,
): string {
  return level === 'host' ? 'this host' : `host group ${levelName(level, host, groupName)}`;
}

/**
 * One forwarding rule: its state, type, `bind:port → target`, where it came from, its `auto` and network
 * badges and what can be done with it. An off rule is greyed with the level that switched it off and offers
 * nothing; a forward whose rule was removed or switched off while it ran offers Stop only, and a forwarding
 * group's member whose rule has gone (and that does not run) offers Remove from group.
 */
export function ForwardRow({
  host,
  forward,
  ruleId,
  state,
  startError,
  groupName,
  showHost = true,
  forwardGroupId,
  onNewGroup,
  onDragChange,
  onSelect,
  selected = false,
}: ForwardRowProps) {
  const file = useHostsStore((s) => s.file);
  const inGroup = groupOfRule(file, host.id, ruleId);
  const otherGroups = (file.forwardGroups ?? []).filter((g) => g.id !== inGroup?.id);
  const rule = forward?.rule;
  const live = isLive(state);
  const failed = state?.status.state === 'failed';
  // A rule switched off while its forward runs still needs its Stop.
  const off = forward !== undefined && !forward.enabled && !live;
  const removed = forward === undefined || !forward.enabled || state?.removed === true;
  // A group member whose rule (or host) has gone: nothing to start or retry, only to take out of the group.
  const dangling = forward === undefined && !live && forwardGroupId !== undefined;
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
      data-selected={selected || undefined}
      {...(onSelect === undefined
        ? {}
        : {
            tabIndex: 0,
            // A click on the row's own buttons and menus does what they say, not a pick.
            onClick: (event: MouseEvent) => {
              if ((event.target as HTMLElement).closest('button, a, input, [role="menuitem"]') !== null) return;
              onSelect(`${host.id}/${ruleId}`);
            },
            onKeyDown: (event: KeyboardEvent) => {
              if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
              event.preventDefault();
              onSelect(`${host.id}/${ruleId}`);
            },
          })}
      {...(onDragChange === undefined || forward === undefined
        ? {}
        : {
            draggable: true,
            onDragStart: (event: DragEvent) => {
              event.dataTransfer.setData(FORWARD_DRAG_TYPE, `${host.id}/${ruleId}`);
              event.dataTransfer.effectAllowed = 'move';
              onDragChange(`${host.id}/${ruleId}`);
            },
            onDragEnd: () => {
              onDragChange(undefined);
            },
          })}
      className={`flex flex-col gap-0.5 px-3 py-2 outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        selected ? 'bg-surface-selected' : onSelect === undefined ? '' : 'hover:bg-surface-hover'
      } ${off ? 'opacity-50' : ''} ${
        onDragChange !== undefined && forward !== undefined ? 'cursor-grab active:cursor-grabbing' : ''
      }`}
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
          <span className="min-w-0 truncate font-mono text-xs text-fg-muted">{routeOf(rule, port)}</span>
        )}
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
            {dangling ? (
              <Button
                className="h-6 px-2 text-xs"
                onClick={() => {
                  move(host.id, ruleId, undefined);
                  // Its failed run, if any, goes with it rather than lingering under Ungrouped.
                  if (state !== undefined) stop();
                }}
              >
                Remove from group
              </Button>
            ) : live || (removed && state !== undefined) ? (
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
                    <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
                    <DropdownMenu.Sub>
                      <DropdownMenu.SubTrigger
                        className={ITEM_CLASS}
                        disabled={otherGroups.length === 0 && onNewGroup === undefined}
                      >
                        Move to group
                      </DropdownMenu.SubTrigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.SubContent className={CONTENT_CLASS}>
                          {otherGroups.map((g) => (
                            <DropdownMenu.Item
                              key={g.id}
                              className={ITEM_CLASS}
                              onSelect={() => {
                                move(host.id, ruleId, g.id);
                              }}
                            >
                              {g.name}
                            </DropdownMenu.Item>
                          ))}
                          {onNewGroup !== undefined && (
                            <DropdownMenu.Item
                              className={ITEM_CLASS}
                              onSelect={() => {
                                onNewGroup(host.id, ruleId);
                              }}
                            >
                              New group…
                            </DropdownMenu.Item>
                          )}
                        </DropdownMenu.SubContent>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Sub>
                    {inGroup !== undefined && (
                      <DropdownMenu.Item
                        className={ITEM_CLASS}
                        onSelect={() => {
                          move(host.id, ruleId, undefined);
                        }}
                      >
                        {`Remove from ${inGroup.name}`}
                      </DropdownMenu.Item>
                    )}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
          </span>
        )}
      </div>
      {/* One quiet line of facts: state (while it runs or failed), type, host and where the rule is set. */}
      <p data-testid="forward-meta" className="truncate pl-4 text-xs text-fg-subtle">
        {[
          !off && (live || failed) ? (
            <span key="state" data-testid="forward-state" className={shown.color}>
              {shown.label}
            </span>
          ) : null,
          rule === undefined ? null : <span key="type">{typeWord(rule.type)}</span>,
          showHost ? (
            <span key="host" className="text-fg-muted">
              {host.name}
            </span>
          ) : null,
          <span key="from">
            {forward === undefined
              ? 'removed from hosts.yaml'
              : !forward.enabled
                ? `off on ${whereFrom(forward.offBy ?? forward.from, host, groupName)}`
                : `defined on ${whereFrom(forward.from, host, groupName)}`}
          </span>,
        ]
          .filter((part) => part !== null)
          .flatMap((part, i) => (i === 0 ? [part] : [<span key={`dot-${String(i)}`}> · </span>, part]))}
      </p>
      {!off && error !== undefined && (
        <p role="alert" className="pl-4 text-xs break-words text-status-danger">
          {error}
        </p>
      )}
    </li>
  );
}
