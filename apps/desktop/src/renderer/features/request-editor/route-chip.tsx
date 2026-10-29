/**
 * The small chip beside a browser tab's Send button (hosted edition spec §18.4): *Server* or *Agent*, for
 * the route the next send takes, and a menu that pins the request, or its whole workspace, to the agent.
 * The route is asked when the chip mounts and again after an edit (debounced by the caller through
 * `scheduleRouteRefresh`). It renders nothing on the desktop (no `env.agent`), which does not route.
 */
import { useEffect, useRef } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { showToast } from '../../components/toast.js';
import {
  routeOf,
  routingActive,
  SEND_NEED_LABELS,
  scheduleRouteRefresh,
  setRoutePin,
  useSendRouteStore,
  type RouteView,
} from '../../state/send-route.js';
import { useProjectStore } from '../../state/project.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent-muted';

/** The chip's title: where the send goes, and why when it is the agent. */
export function routeTitle(view: RouteView | undefined): string {
  if (view === undefined) return 'Which host sends this request';
  if (view.route === 'server') return 'Sent from the server';
  return `Sent from this machine: it needs ${view.needs.map((need) => SEND_NEED_LABELS[need]).join(', ')}`;
}

export function RouteChip({ requestId }: { readonly requestId: string }) {
  const view = useSendRouteStore((state) => state.byRequest[requestId]);
  const routing = routingActive();

  // The request as the editor holds it: a new object on every edit and every model update.
  const edited = useProjectStore((state) => state.restRequests[requestId] ?? state.requests[requestId]);
  const asked = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!routing) return;
    if (asked.current !== requestId) {
      asked.current = requestId;
      void routeOf(requestId).catch(() => undefined);
      return;
    }
    scheduleRouteRefresh(requestId);
  }, [routing, requestId, edited]);

  if (!routing) return null;

  const pins = view?.info?.pins;
  const pin = (scope: 'request' | 'workspace', value: 'agent' | null): void => {
    void setRoutePin(requestId, scope, value).then((result) => {
      if (!result.ok) showToast(result.error.message);
    });
  };

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid="send-route-chip"
          data-route={view?.route ?? 'unknown'}
          title={routeTitle(view)}
          className="h-5 shrink-0 rounded border border-hairline bg-surface-raised px-1.5 text-2xs text-fg-subtle hover:text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
        >
          {view?.route === 'agent' ? 'Agent' : 'Server'}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className="z-dropdown min-w-48 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
        >
          {pins?.request === true ? (
            <DropdownMenu.Item className={ITEM_CLASS} data-testid="route-unpin" onSelect={() => pin('request', null)}>
              Unpin this request
            </DropdownMenu.Item>
          ) : (
            <DropdownMenu.Item className={ITEM_CLASS} data-testid="route-pin" onSelect={() => pin('request', 'agent')}>
              Pin to agent
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item
            className={ITEM_CLASS}
            data-testid="route-pin-workspace"
            disabled={view?.info?.workspaceId === undefined}
            onSelect={() => pin('workspace', pins?.workspace === true ? null : 'agent')}
          >
            {pins?.workspace === true ? 'Unpin the workspace' : 'Pin the whole workspace to agent'}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
