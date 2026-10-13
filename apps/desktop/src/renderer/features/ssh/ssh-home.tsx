/**
 * The SSH area's fixed first tab: what the area's menu picks — the hosts as cards, the keychain
 * (the secret names hosts sign in with) or the host keys trusted on this machine. Terminal
 * sessions open as tabs after it.
 */
import { useEffect, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  Download,
  FolderPlus,
  KeyRound,
  LayoutGrid,
  List,
  Plus,
  Search,
  Server,
} from 'lucide-react';
import { Button, SPLIT_HEAD_CLASS, SPLIT_TAIL_CLASS } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import type {
  GroupEntryWire,
  HostsFileWire,
  ResolvedHostWire,
  SshKnownHostWire,
  SshSecretNameWire,
} from '../../../shared/ssh-wire.js';
import { detectPlatform } from '../../lib/platform.js';
import { ipc } from '../../state/ipc-client.js';
import { HostCards } from './host-cards.js';
import { ForwardingPanel } from './forwarding/forwarding-view.js';
import { LayoutsPanel } from './panes/layouts-view.js';
import { SnippetsPanel } from './snippets/snippets-panel.js';
import { useHostsPrefs, type HostsSort } from './hosts-prefs.js';
import { flattenGroups, useHostsStore } from './hosts-store.js';
import { RecentSection } from './recent-section.js';
import {
  CopyPublicKeyButton,
  GenerateKeyDialog,
  InstallKeyDialog,
  keyTypeLabel,
  useKeyInstall,
  useSshKeys,
} from './ssh-keys.js';

const INPUT_CLASS =
  'w-full rounded-md border border-hairline-strong bg-surface-base px-2 py-1 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent';

export function SshHome() {
  const view = useHostsStore((s) => s.homeView);
  return (
    <div data-testid="ssh-home" className="h-full min-h-0 overflow-auto p-4">
      {view === 'hosts' ? (
        <HostsPanel />
      ) : view === 'snippets' ? (
        <SnippetsPanel />
      ) : view === 'layouts' ? (
        <LayoutsPanel />
      ) : view === 'forwarding' ? (
        <ForwardingPanel />
      ) : view === 'keychain' ? (
        <KeychainPanel />
      ) : (
        <KnownHostsPanel />
      )}
      <InstallKeyDialog />
    </div>
  );
}

const SORT_LABELS: Readonly<Record<HostsSort, string>> = {
  name: 'Name',
  address: 'Address',
  connected: 'Connected first',
  recent: 'Recently connected',
};

const MENU_CONTENT_CLASS = 'z-50 min-w-44 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg';
const MENU_ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

/** Every group from the top, named by its path, with how many hosts it holds counting the groups inside it. */
function groupChipsOf(file: HostsFileWire): { id: string; title: string; count: number }[] {
  const out: { id: string; title: string; count: number }[] = [];
  const walk = (groups: readonly GroupEntryWire[], prefix: string): number => {
    let total = 0;
    for (const group of groups) {
      const title = prefix === '' ? group.name : `${prefix} / ${group.name}`;
      const at = out.push({ id: group.id, title, count: 0 }) - 1;
      const count = group.hosts.length + walk(group.groups, title);
      const chip = out[at];
      if (chip !== undefined) chip.count = count;
      total += count;
    }
    return total;
  };
  walk(file.groups, '');
  return out;
}

const CHIP_CLASS = 'rounded-full border px-2 py-0.5 text-xs';
const chipState = (on: boolean): string =>
  on ? 'border-accent bg-accent-muted text-fg-default' : 'border-hairline text-fg-subtle hover:bg-surface-raised';

/** The groups as filters: picking one shows only its hosts; picking it again, or All, shows every host. */
function GroupChips() {
  const file = useHostsStore((s) => s.file);
  const groupFilter = useHostsStore((s) => s.groupFilter);
  const setGroupFilter = useHostsStore((s) => s.setGroupFilter);
  const chips = groupChipsOf(file);
  if (chips.length === 0) return null;
  const active = chips.some((c) => c.id === groupFilter) ? groupFilter : undefined;
  const total = file.hosts.length + flattenGroups(file).reduce((sum, { group }) => sum + group.hosts.length, 0);
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by group">
      <button
        type="button"
        aria-pressed={active === undefined}
        onClick={() => {
          setGroupFilter(undefined);
        }}
        className={`${CHIP_CLASS} ${chipState(active === undefined)}`}
      >
        All <span className="opacity-70">{total}</span>
      </button>
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          aria-pressed={active === chip.id}
          onClick={() => {
            setGroupFilter(active === chip.id ? undefined : chip.id);
          }}
          className={`${CHIP_CLASS} ${chipState(active === chip.id)}`}
        >
          {chip.title} <span className="opacity-70">{chip.count}</span>
        </button>
      ))}
    </div>
  );
}

function HostsPanel() {
  const resolved = useHostsStore((s) => s.resolved);
  const problems = useHostsStore((s) => s.problems);
  const filter = useHostsStore((s) => s.filter);
  const setFilter = useHostsStore((s) => s.setFilter);
  const selectedTags = useHostsStore((s) => s.selectedTags);
  const toggleTag = useHostsStore((s) => s.toggleTag);
  const openDialog = useHostsStore((s) => s.openDialog);
  const setImportOpen = useHostsStore((s) => s.setImportOpen);
  const [prefs, setPrefs] = useHostsPrefs();
  const searchRef = useRef<HTMLInputElement>(null);
  const tags = [...new Set(resolved.flatMap((h) => h.tags))].sort();
  const mac = detectPlatform() === 'mac';

  // ⌘F (Ctrl+F elsewhere) goes to the search while this tab is in front.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if ((mac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [mac]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-2 flex items-baseline gap-2 text-lg font-medium text-fg-default">
          Hosts <span className="text-sm font-normal text-fg-subtle">{resolved.length}</span>
        </h2>
        <label className="relative flex max-w-md min-w-48 flex-1 items-center">
          <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2 text-fg-subtle" />
          <input
            ref={searchRef}
            type="search"
            aria-label="Filter hosts"
            placeholder="Search hosts…"
            className={`${INPUT_CLASS} pr-12 pl-7`}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter !== '') {
                e.stopPropagation();
                setFilter('');
              }
            }}
          />
          <kbd className="pointer-events-none absolute right-2 rounded border border-hairline px-1 font-sans text-xs text-fg-subtle">
            {mac ? '⌘F' : 'Ctrl+F'}
          </kbd>
        </label>
        <div className="ml-auto flex items-center gap-2">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button variant="ghost" aria-label={`Sort by ${SORT_LABELS[prefs.sort]}`}>
                <ArrowUpDown size={13} aria-hidden="true" /> {SORT_LABELS[prefs.sort]}
                <ChevronDown size={12} aria-hidden="true" />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={4} className={MENU_CONTENT_CLASS}>
                <DropdownMenu.RadioGroup
                  value={prefs.sort}
                  onValueChange={(value) => {
                    setPrefs({ sort: value as HostsSort });
                  }}
                >
                  {(Object.keys(SORT_LABELS) as HostsSort[]).map((sort) => (
                    <DropdownMenu.RadioItem key={sort} value={sort} className={MENU_ITEM_CLASS}>
                      <span className="w-3">
                        <DropdownMenu.ItemIndicator>
                          <Check size={12} aria-hidden="true" />
                        </DropdownMenu.ItemIndicator>
                      </span>
                      {SORT_LABELS[sort]}
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <div role="group" aria-label="Layout" className="flex rounded-md border border-hairline-strong">
            {(
              [
                ['grid', 'Cards', LayoutGrid],
                ['list', 'List', List],
              ] as const
            ).map(([layout, label, Icon]) => (
              <button
                key={layout}
                type="button"
                aria-label={label}
                aria-pressed={prefs.layout === layout}
                onClick={() => {
                  setPrefs({ layout });
                }}
                className={`inline-flex h-row w-7 items-center justify-center first:rounded-l-md last:rounded-r-md ${
                  prefs.layout === layout
                    ? 'bg-accent-muted text-fg-default'
                    : 'text-fg-subtle hover:bg-surface-hover hover:text-fg-default'
                }`}
              >
                <Icon size={14} aria-hidden="true" />
              </button>
            ))}
          </div>
          <div className="flex">
            <Button
              variant="primary"
              className={SPLIT_HEAD_CLASS}
              onClick={() => {
                openDialog({ mode: 'new-host' });
              }}
            >
              <Plus size={13} aria-hidden /> New host
            </Button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button variant="primary" aria-label="More ways to add" className={SPLIT_TAIL_CLASS}>
                  <ChevronDown size={13} aria-hidden="true" />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={4} className={MENU_CONTENT_CLASS}>
                  <DropdownMenu.Item
                    className={MENU_ITEM_CLASS}
                    onSelect={() => {
                      openDialog({ mode: 'new-host' });
                    }}
                  >
                    <Server size={13} aria-hidden="true" /> New host
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className={MENU_ITEM_CLASS}
                    onSelect={() => {
                      openDialog({ mode: 'new-group' });
                    }}
                  >
                    <FolderPlus size={13} aria-hidden="true" /> New group
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className={MENU_ITEM_CLASS}
                    onSelect={() => {
                      setImportOpen(true);
                    }}
                  >
                    <Download size={13} aria-hidden="true" /> Import from SSH config…
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
      </div>
      <GroupChips />
      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by tag">
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              aria-pressed={selectedTags.includes(tag)}
              onClick={() => {
                toggleTag(tag);
              }}
              className={`${CHIP_CLASS} ${chipState(selectedTags.includes(tag))}`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      {problems.length > 0 && (
        <ul role="alert" aria-label="Hosts problems" className="flex flex-col gap-1 text-sm">
          {problems.map((p, i) => (
            <li
              key={`${p.code}-${String(i)}`}
              className="rounded border border-status-danger px-2 py-1 text-fg-default"
            >
              <span className="font-mono text-xs text-status-danger">{p.code}</span> <span>{p.message}</span>
              {p.path !== undefined && <span className="ml-1 font-mono text-xs text-fg-subtle">{p.path}</span>}
            </li>
          ))}
        </ul>
      )}
      {/* A search is after a host by name: the recent strip would only push the matches down. */}
      {filter.trim() === '' && selectedTags.length === 0 && <RecentSection />}
      <HostCards prefs={prefs} onPrefs={setPrefs} />
    </div>
  );
}

/** The names of the hosts that sign in with secret `name`: as their password, key or key passphrase. */
function usersOf(name: string, hosts: readonly ResolvedHostWire[]): string[] {
  return hosts
    .filter((host) => {
      const auth = host.ssh.auth.value;
      if (auth === undefined || auth.kind === 'agent') return false;
      return auth.secret === name || (auth.kind === 'key' && auth.passphraseSecret === name);
    })
    .map((host) => host.name);
}

interface SecretForm {
  readonly name: string;
  /** Setting the value of a listed name: the name is not editable. */
  readonly fixed: boolean;
  readonly value: string;
  readonly error?: string;
}

function KeychainPanel() {
  const resolved = useHostsStore((s) => s.resolved);
  const [names, setNames] = useState<readonly SshSecretNameWire[]>();
  // The value is write-only: it goes to main and never comes back.
  const [form, setForm] = useState<SecretForm>();
  const [generating, setGenerating] = useState(false);
  // Bumped with every listing, so a key stored from the form is recognised as one too.
  const [listing, setListing] = useState(0);
  const keys = useSshKeys(listing);
  const openInstall = useKeyInstall((s) => s.open);

  const load = async (): Promise<void> => {
    const result = await ipc().ssh.secretNames(undefined);
    setNames(result.ok ? result.value.names : []);
    setListing((n) => n + 1);
  };
  useEffect(() => {
    void load();
  }, []);

  const store = async (current: SecretForm): Promise<void> => {
    const name = current.name.trim();
    if (name === '') return;
    const result = await ipc().ssh.setSecret({ name, value: current.value });
    if (!result.ok) {
      setForm({ ...current, value: '', error: result.error.message });
      return;
    }
    setForm(undefined);
    await load();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <p className="flex-1 text-sm text-fg-subtle">
          The passwords and private keys hosts sign in with, by name. A value is stored on this machine for the
          workspace and is never shown again.
        </p>
        <Button
          onClick={() => {
            setGenerating(true);
          }}
        >
          <KeyRound size={13} aria-hidden /> Generate key…
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            setForm({ name: '', fixed: false, value: '' });
          }}
        >
          <Plus size={13} aria-hidden /> New secret
        </Button>
      </div>
      {form !== undefined && (
        <form
          aria-label="Store a secret"
          className="flex flex-wrap items-end gap-2 rounded-md border border-hairline p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void store(form);
          }}
        >
          <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-fg-subtle">
            Secret name
            <input
              className={`${INPUT_CLASS} font-mono`}
              value={form.name}
              readOnly={form.fixed}
              autoFocus={!form.fixed}
              onChange={(e) => {
                setForm({ ...form, name: e.target.value });
              }}
            />
          </label>
          <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-fg-subtle">
            Secret value
            <textarea
              rows={1}
              className={`${INPUT_CLASS} font-mono`}
              value={form.value}
              autoFocus={form.fixed}
              onChange={(e) => {
                setForm({ ...form, value: e.target.value });
              }}
            />
          </label>
          <Button type="submit" variant="primary" disabled={form.name.trim() === ''}>
            Store
          </Button>
          <Button
            onClick={() => {
              setForm(undefined);
            }}
          >
            Cancel
          </Button>
          {form.error !== undefined && (
            <p role="alert" className="w-full text-sm text-status-danger">
              {form.error}
            </p>
          )}
        </form>
      )}
      {names === undefined ? null : names.length === 0 ? (
        <p className="text-sm text-fg-subtle">No secrets yet. Store one here, or from a host's sign-in settings.</p>
      ) : (
        <ul aria-label="Secrets" className="flex flex-col divide-y divide-hairline rounded-md border border-hairline">
          {names.map((secret) => {
            const users = usersOf(secret.name, resolved);
            const key = keys.get(secret.name);
            return (
              <li
                key={secret.name}
                data-testid={`secret-row-${secret.name}`}
                className="flex items-center gap-3 px-3 py-2"
              >
                <KeyRound size={15} aria-hidden="true" className="shrink-0 text-fg-subtle" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-sm text-fg-default">{secret.name}</span>
                  {key?.fingerprint !== undefined && (
                    <span className="truncate font-mono text-xs text-fg-subtle">
                      {keyTypeLabel(key.keyType)} · {key.fingerprint}
                    </span>
                  )}
                  <span className="truncate text-xs text-fg-subtle">
                    {users.length === 0 ? 'Not used by any host' : `Used by ${users.join(', ')}`}
                  </span>
                </span>
                {key?.locked === true && (
                  <span
                    title={`Store its passphrase as ${secret.name}_passphrase to use this key here`}
                    className="shrink-0 rounded-full border border-status-warning px-1.5 text-xs text-status-warning"
                  >
                    locked key
                  </span>
                )}
                {secret.external && (
                  <span className="shrink-0 rounded-full border border-hairline px-1.5 text-xs text-fg-subtle">
                    from a secret source
                  </span>
                )}
                {secret.local && (
                  <span className="shrink-0 rounded-full border border-hairline px-1.5 text-xs text-fg-subtle">
                    on this machine
                  </span>
                )}
                {!secret.local && !secret.external && (
                  <span className="shrink-0 rounded-full border border-status-warning px-1.5 text-xs text-status-warning">
                    no value
                  </span>
                )}
                {key?.publicKey !== undefined && (
                  <>
                    <CopyPublicKeyButton publicKey={key.publicKey} />
                    <Button
                      onClick={() => {
                        openInstall({ secret: secret.name });
                      }}
                    >
                      Install on host…
                    </Button>
                  </>
                )}
                <Button
                  onClick={() => {
                    setForm({ name: secret.name, fixed: true, value: '' });
                  }}
                >
                  Set value…
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <GenerateKeyDialog
        open={generating}
        onClose={() => {
          setGenerating(false);
        }}
        onGenerated={() => {
          setGenerating(false);
          void load();
        }}
      />
    </div>
  );
}

function KnownHostsPanel() {
  const [entries, setEntries] = useState<readonly SshKnownHostWire[]>();
  const [error, setError] = useState<string>();
  const [forgetting, setForgetting] = useState<SshKnownHostWire>();
  const setImportOpen = useHostsStore((s) => s.setKnownHostsImportOpen);
  // An import writes keys from the dialog in the Hosts sidebar; the list reads again when it does.
  const revision = useHostsStore((s) => s.knownHostsRevision);

  const load = async (): Promise<void> => {
    const result = await ipc().ssh.knownHosts(undefined);
    if (result.ok) {
      setEntries(result.value.entries);
    } else {
      setEntries([]);
      setError(result.error.message);
    }
  };
  useEffect(() => {
    void load();
  }, [revision]);

  const forget = async (entry: SshKnownHostWire): Promise<void> => {
    const result = await ipc().ssh.forgetHostKey({ host: entry.host, keyType: entry.keyType });
    setError(result.ok ? undefined : result.error.message);
    await load();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <p className="flex-1 text-sm text-fg-subtle">
          The host keys you trusted on this machine. Forgetting one makes the next connection to that host ask again.
        </p>
        <Button
          onClick={() => {
            setImportOpen(true);
          }}
        >
          Import known hosts…
        </Button>
      </div>
      {error !== undefined && (
        <p role="alert" className="text-sm text-status-danger">
          {error}
        </p>
      )}
      {entries === undefined ? null : entries.length === 0 ? (
        <p className="text-sm text-fg-subtle">No trusted host keys yet. The first connection to a host asks.</p>
      ) : (
        <ul
          aria-label="Known hosts"
          className="flex flex-col divide-y divide-hairline rounded-md border border-hairline"
        >
          {entries.map((entry) => (
            <li
              key={`${entry.host} ${entry.keyType}`}
              data-testid={`known-host-${entry.host}`}
              className="flex items-center gap-3 px-3 py-2"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-sm text-fg-default">{entry.host}</span>
                <span className="truncate font-mono text-xs text-fg-subtle">
                  {entry.keyType} {entry.fingerprint}
                </span>
              </span>
              <Button
                onClick={() => {
                  setForgetting(entry);
                }}
              >
                Forget
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={forgetting !== undefined}
        onOpenChange={(open) => {
          if (!open) setForgetting(undefined);
        }}
        title="Forget this host key?"
        description={
          forgetting === undefined
            ? ''
            : `The next connection to ${forgetting.host} will ask you to trust its ${forgetting.keyType} key again.`
        }
        confirmLabel="Forget"
        destructive
        onConfirm={() => {
          const entry = forgetting;
          setForgetting(undefined);
          if (entry !== undefined) void forget(entry);
        }}
      />
    </div>
  );
}
