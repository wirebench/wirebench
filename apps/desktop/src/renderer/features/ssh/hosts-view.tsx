import { lazy, Suspense, useEffect, useState } from 'react';
import {
  ArrowLeftRight,
  KeyRound,
  LayoutPanelLeft,
  Server,
  ShieldCheck,
  SquareTerminal,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { useEditorsStore } from '../../state/editors.js';
import { ipc } from '../../state/ipc-client.js';
import { useUiStore } from '../../state/ui.js';
import { forwardCounts, useForwardsStore } from './forwarding/forwards-store.js';
import { useHostsStore, type SshHomeView } from './hosts-store.js';
import { openLocalTerminal } from './local-terminal.js';
import { refreshLayouts, useLayoutsStore } from './panes/layouts-store.js';
import { useSnippetsStore } from './snippets/snippets-store.js';

// The dialogs load the first time one opens: the sidebar shows on every start in the SSH area.
const HostDialog = lazy(async () => {
  const module = await import('./host-dialog.js');
  return { default: module.HostDialog };
});
const ImportDialog = lazy(async () => {
  const module = await import('./import-dialog.js');
  return { default: module.ImportDialog };
});
const KnownHostsImportDialog = lazy(async () => {
  const module = await import('./known-hosts-import-dialog.js');
  return { default: module.KnownHostsImportDialog };
});

/*
 * `label` is the menu's; the view's own title (`ssh-views.ts`) may be longer. "Forwarding" with its running
 * count fits the default sidebar width, where "Port forwarding" was cut short (#593).
 */
const ENTRIES: readonly {
  readonly id: SshHomeView;
  readonly label: string;
  readonly title?: string;
  readonly icon: LucideIcon;
}[] = [
  { id: 'hosts', label: 'Hosts', icon: Server },
  { id: 'snippets', label: 'Snippets', icon: SquareTerminal },
  { id: 'layouts', label: 'Layouts', icon: LayoutPanelLeft },
  { id: 'forwarding', label: 'Forwarding', title: 'Port forwarding', icon: ArrowLeftRight },
  { id: 'keychain', label: 'Keychain', icon: KeyRound },
  { id: 'known-hosts', label: 'Known hosts', icon: ShieldCheck },
];

/*
 * The menu reads its own width (it is a container). From 7.5rem an entry is icon, label and count, the label
 * cut short with an ellipsis; narrower than that the menu is an icon rail, the label kept for screen
 * readers and in the tooltip.
 */
const ENTRY_CLASS =
  'flex w-full items-center justify-center gap-2 rounded-md px-2 py-1.5 text-sm @min-[7.5rem]:justify-start';
const LABEL_CLASS =
  'sr-only @min-[7.5rem]:not-sr-only @min-[7.5rem]:min-w-0 @min-[7.5rem]:flex-1 @min-[7.5rem]:truncate @min-[7.5rem]:text-left';
const COUNT_CLASS = 'hidden flex-none text-xs text-fg-subtle @min-[7.5rem]:inline';

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
  const secretsRevision = useHostsStore((s) => s.secretsRevision);
  const [counts, setCounts] = useState<{ keychain?: number; knownHosts?: number }>({});
  const localTerminal = useUiStore((s) => s.localTerminalEnabled);
  // Only a group's form is a dialog: a host's, new or edited, opens in the details panel.
  const hostDialogOpen = useHostsStore((s) => s.dialog?.mode === 'new-group' || s.dialog?.mode === 'edit-group');
  const importOpen = useHostsStore((s) => s.importOpen);
  const knownHostsImportOpen = useHostsStore((s) => s.knownHostsImportOpen);

  useEffect(() => {
    void refresh();
    useSnippetsStore
      .getState()
      .refresh()
      .catch(() => undefined); // only the count: the Snippets view reads again when shown
    refreshLayouts(); // likewise the Layouts count
  }, [refresh]);

  // Counted again when the menu is picked from, the hosts are saved, keys are imported or anything writes
  // to the keychain (a key generated, a secret stored anywhere), so the counts never lag the views.
  useEffect(() => {
    void (async () => {
      const [names, known] = await Promise.all([ipc().ssh.secretNames(undefined), ipc().ssh.knownHosts(undefined)]);
      setCounts({
        ...(names.ok ? { keychain: names.value.names.length } : {}),
        ...(known.ok ? { knownHosts: known.value.entries.length } : {}),
      });
    })();
  }, [homeView, homeShown, resolved, knownHostsRevision, secretsRevision]);

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
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto p-2">
      <nav aria-label="SSH">
        <ul className="flex flex-col gap-0.5">
          {ENTRIES.map(({ id, label, title: name = label, icon: Icon }) => {
            const current = homeShown && homeView === id;
            // A zero says nothing on a first run, so it is left out; forwards count only the running ones.
            const count = countOf(id) || undefined;
            const running = id === 'forwarding';
            return (
              <li key={id}>
                <button
                  type="button"
                  data-testid={`ssh-nav-${id}`}
                  aria-current={current ? 'page' : undefined}
                  title={count === undefined ? name : `${name} (${String(count)}${running ? ' running' : ''})`}
                  onClick={() => {
                    open(id);
                  }}
                  className={`${ENTRY_CLASS} ${
                    current ? 'bg-accent-muted text-fg-default' : 'text-fg-muted hover:bg-surface-raised'
                  }`}
                >
                  <Icon size={15} aria-hidden="true" className="shrink-0" />
                  <span className={LABEL_CLASS}>{label}</span>
                  {count !== undefined &&
                    (running ? (
                      <span data-testid="ssh-nav-forwarding-running" className={`${COUNT_CLASS} items-center gap-1`}>
                        <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-status-success" />
                        {count}
                      </span>
                    ) : (
                      <span className={COUNT_CLASS}>{count}</span>
                    ))}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      {localTerminal && (
        <div className="mt-2 border-t border-hairline pt-2">
          <button
            type="button"
            data-testid="ssh-new-local-terminal"
            title="New local terminal"
            onClick={() => {
              openLocalTerminal();
            }}
            className={`${ENTRY_CLASS} text-fg-muted hover:bg-surface-raised`}
          >
            <Terminal size={15} aria-hidden="true" className="shrink-0" />
            <span className={LABEL_CLASS}>New local terminal</span>
          </button>
        </div>
      )}
      {hostDialogOpen && (
        <Suspense fallback={null}>
          <HostDialog />
        </Suspense>
      )}
      {importOpen && (
        <Suspense fallback={null}>
          <ImportDialog />
        </Suspense>
      )}
      {knownHostsImportOpen && (
        <Suspense fallback={null}>
          <KnownHostsImportDialog />
        </Suspense>
      )}
    </div>
  );
}
