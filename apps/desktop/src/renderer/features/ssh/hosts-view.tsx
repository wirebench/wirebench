import { useEffect, useState } from 'react';
import {
  ArrowLeftRight,
  KeyRound,
  LayoutPanelLeft,
  Server,
  ShieldCheck,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import { useEditorsStore } from '../../state/editors.js';
import { ipc } from '../../state/ipc-client.js';
import { forwardCounts, useForwardsStore } from './forwarding/forwards-store.js';
import { HostDialog } from './host-dialog.js';
import { useHostsStore, type SshHomeView } from './hosts-store.js';
import { ImportDialog } from './import-dialog.js';
import { KnownHostsImportDialog } from './known-hosts-import-dialog.js';
import { refreshLayouts, useLayoutsStore } from './panes/layouts-store.js';
import { useSnippetsStore } from './snippets/snippets-store.js';

const ENTRIES: readonly { readonly id: SshHomeView; readonly label: string; readonly icon: LucideIcon }[] = [
  { id: 'hosts', label: 'Hosts', icon: Server },
  { id: 'snippets', label: 'Snippets', icon: SquareTerminal },
  { id: 'layouts', label: 'Layouts', icon: LayoutPanelLeft },
  { id: 'forwarding', label: 'Port forwarding', icon: ArrowLeftRight },
  { id: 'keychain', label: 'Keychain', icon: KeyRound },
  { id: 'known-hosts', label: 'Known hosts', icon: ShieldCheck },
];

/**
 * The SSH sidebar: a menu of what the area keeps. Picking an entry shows it in the area's fixed
 * first tab (`ssh-home.tsx`), in front of any open terminal.
 */
export function HostsView() {
  const refresh = useHostsStore((s) => s.refresh);
  const resolved = useHostsStore((s) => s.resolved);
  const snippetCount = useSnippetsStore((s) => s.snippets.length);
  const layoutCount = useLayoutsStore((s) => (s.loaded ? s.layouts.length : undefined));
  const runningForwards = useForwardsStore((s) => forwardCounts(s.byKey).running);
  const homeView = useHostsStore((s) => s.homeView);
  const setHomeView = useHostsStore((s) => s.setHomeView);
  // Whether the fixed tab is the one in front: the entry only reads as current while it is.
  const homeShown = useEditorsStore((s) => s.displayedSet === 'ssh' && s.activeId === undefined);
  const knownHostsRevision = useHostsStore((s) => s.knownHostsRevision);
  const [counts, setCounts] = useState<{ keychain?: number; knownHosts?: number }>({});

  useEffect(() => {
    void refresh();
    useSnippetsStore
      .getState()
      .refresh()
      .catch(() => undefined); // only the count: the Snippets view reads again when shown
    refreshLayouts(); // likewise the Layouts count
  }, [refresh]);

  // Counted again when the menu is picked from or the hosts are saved (a host's dialog can store a
  // secret), so a key trusted or a secret stored since shows.
  useEffect(() => {
    void (async () => {
      const [names, known] = await Promise.all([ipc().ssh.secretNames(undefined), ipc().ssh.knownHosts(undefined)]);
      setCounts({
        ...(names.ok ? { keychain: names.value.names.length } : {}),
        ...(known.ok ? { knownHosts: known.value.entries.length } : {}),
      });
    })();
  }, [homeView, homeShown, resolved, knownHostsRevision]);

  const countOf = (id: SshHomeView): number | undefined =>
    id === 'hosts'
      ? resolved.length
      : id === 'snippets'
        ? snippetCount
        : id === 'layouts'
          ? layoutCount
          : id === 'forwarding'
            ? runningForwards
            : id === 'keychain'
              ? counts.keychain
              : counts.knownHosts;

  const open = (id: SshHomeView): void => {
    setHomeView(id);
    const editors = useEditorsStore.getState();
    editors.showSet('ssh');
    editors.showStart();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-2">
      <nav aria-label="SSH">
        <ul className="flex flex-col gap-0.5">
          {ENTRIES.map(({ id, label, icon: Icon }) => {
            const current = homeShown && homeView === id;
            const count = countOf(id);
            return (
              <li key={id}>
                <button
                  type="button"
                  data-testid={`ssh-nav-${id}`}
                  aria-current={current ? 'page' : undefined}
                  onClick={() => {
                    open(id);
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                    current ? 'bg-accent-muted text-fg-default' : 'text-fg-muted hover:bg-surface-raised'
                  }`}
                >
                  <Icon size={15} aria-hidden="true" className="shrink-0" />
                  <span className="flex-1 text-left">{label}</span>
                  {count !== undefined && <span className="text-xs text-fg-subtle">{count}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <HostDialog />
      <ImportDialog />
      <KnownHostsImportDialog />
    </div>
  );
}
