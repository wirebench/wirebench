/**
 * The SSH area's fixed first tab: what the area's menu picks — the hosts as cards, the keychain
 * (the secret names hosts sign in with) or the host keys trusted on this machine. Terminal
 * sessions open as tabs after it.
 */
import { useEffect, useState } from 'react';
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
  MoreHorizontal,
  Plus,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { Button, SPLIT_HEAD_CLASS, SPLIT_TAIL_CLASS } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { showToast } from '../../components/toast.js';
import type { ResolvedHostWire, SshKnownHostWire, SshSecretNameWire } from '../../../shared/ssh-wire.js';
import { ipc } from '../../state/ipc-client.js';
import { HostCards } from './host-cards.js';
import { ForwardingPanel } from './forwarding/forwarding-view.js';
import { LayoutsPanel } from './panes/layouts-view.js';
import { SnippetsPanel } from './snippets/snippets-panel.js';
import { useHostsPrefs, type HostsSort } from './hosts-prefs.js';
import { flattenGroups, osKeyOf, useHostsStore } from './hosts-store.js';
import { IdentitiesSection } from './identities-section.js';
import { RecentSection } from './recent-section.js';
import { SshEmptyState, SshNoMatches, SshView, SshViewHeader } from './ssh-view-frame.js';
import { SSH_VIEWS } from './ssh-views.js';
import {
  AttachCertificateDialog,
  CertificateSummary,
  GenerateKeyDialog,
  InstallKeyDialog,
  keyTypeLabel,
  useKeyInstall,
  useSshKeys,
} from './ssh-keys.js';
import { storeSshSecret } from './secret-writes.js';

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

const MENU_CONTENT_CLASS = 'z-dropdown min-w-44 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg';
const MENU_ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

const CHIP_CLASS = 'rounded-full border px-2 py-0.5 text-xs';
const chipState = (on: boolean): string =>
  on ? 'border-accent bg-accent-muted text-fg-default' : 'border-hairline text-fg-subtle hover:bg-surface-raised';

/**
 * While the list is narrowed to one group (its heading's "Show only this group"), says which, with a way back.
 * The sections themselves are how groups show; a group gone from the file narrows nothing.
 */
function GroupFilterBar() {
  const file = useHostsStore((s) => s.file);
  const groupFilter = useHostsStore((s) => s.groupFilter);
  const setGroupFilter = useHostsStore((s) => s.setGroupFilter);
  const group = flattenGroups(file).find((g) => g.group.id === groupFilter)?.group;
  if (group === undefined) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-fg-subtle" data-testid="hosts-group-filter">
      <span>
        Showing only <span className="font-medium text-fg-default">{group.name}</span>
      </span>
      <button
        type="button"
        onClick={() => {
          setGroupFilter(undefined);
        }}
        className="rounded px-1 text-accent hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
      >
        Show all groups
      </button>
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
  const tags = [...new Set(resolved.flatMap((h) => h.tags))].sort();

  return (
    <SshView>
      <SshViewHeader
        title={SSH_VIEWS.hosts.label}
        count={resolved.length}
        search={{ value: filter, onChange: setFilter, label: 'Filter hosts', placeholder: 'Search hosts…' }}
        description="The servers you connect to. Double-click one to open a terminal."
        actions={
          <>
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
                      <FolderPlus size={13} aria-hidden="true" /> New host group
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className={MENU_ITEM_CLASS}
                      onSelect={() => {
                        setImportOpen(true);
                      }}
                    >
                      <Download size={13} aria-hidden="true" /> Import hosts…
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          </>
        }
      />
      <GroupFilterBar />
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
    </SshView>
  );
}

/** The names of the hosts that sign in with secret `name`: as their password, key, key passphrase or certificate. */
function usersOf(name: string, hosts: readonly ResolvedHostWire[]): string[] {
  return hosts
    .filter((host) => {
      const auth = host.ssh.auth.value;
      if (auth === undefined || auth.kind === 'agent') return false;
      return (
        auth.secret === name ||
        (auth.kind === 'key' && (auth.passphraseSecret === name || auth.certificateSecret === name))
      );
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
  const [attaching, setAttaching] = useState<string>();
  // Bumped with every listing, so a key stored from the form is recognised as one too.
  const [listing, setListing] = useState(0);
  const [filter, setFilter] = useState('');
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
    const result = await storeSshSecret({ name, value: current.value });
    if (!result.ok) {
      setForm({ ...current, value: '', error: result.error.message });
      return;
    }
    setForm(undefined);
    await load();
  };

  const needle = filter.trim().toLowerCase();
  const shown = (names ?? []).filter(
    (secret) =>
      needle === '' ||
      [secret.name, ...usersOf(secret.name, resolved)].some((field) => field.toLowerCase().includes(needle)),
  );
  const generate = (): void => {
    setGenerating(true);
  };
  const newSecret = (): void => {
    setForm({ name: '', fixed: false, value: '' });
  };

  return (
    <SshView>
      <SshViewHeader
        title={SSH_VIEWS.keychain.label}
        {...(names === undefined ? {} : { count: names.length })}
        search={{
          value: filter,
          onChange: setFilter,
          label: 'Filter secrets',
          placeholder: 'Search identities and secrets…',
        }}
        description="The identities, passwords and private keys hosts sign in with, by name. A value is stored on this machine for the workspace and is never shown again."
        actions={
          <>
            <Button onClick={generate}>
              <KeyRound size={13} aria-hidden /> Generate key…
            </Button>
            <Button variant="primary" onClick={newSecret}>
              <Plus size={13} aria-hidden /> New secret
            </Button>
          </>
        }
      />
      <IdentitiesSection filter={filter} />
      <h3 className="text-sm font-medium text-fg-default">Secrets</h3>
      {form !== undefined && (
        <form
          aria-label="Store a secret"
          className="flex flex-wrap items-end gap-2 rounded-md border border-hairline p-3"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            setForm(undefined);
          }}
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
        <SshEmptyState
          icon={KeyRound}
          text="Store the passwords and private keys your hosts sign in with, or generate a new key here."
          testId="keychain-empty"
        >
          <Button variant="primary" onClick={generate}>
            <KeyRound size={13} aria-hidden /> Generate key…
          </Button>
          <Button onClick={newSecret}>
            <Plus size={13} aria-hidden /> New secret
          </Button>
        </SshEmptyState>
      ) : shown.length === 0 ? (
        <SshNoMatches
          text="No secret matches the search."
          onClear={() => {
            setFilter('');
          }}
        />
      ) : (
        <ul aria-label="Secrets" className="flex flex-col divide-y divide-hairline rounded-md border border-hairline">
          {shown.map((secret) => {
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
                    <span className="font-mono text-xs break-all text-fg-subtle">
                      {keyTypeLabel(key.keyType)} · {key.fingerprint}
                    </span>
                  )}
                  {key?.certificate !== undefined && <CertificateSummary certificate={key.certificate} />}
                  {key?.certificateError !== undefined && (
                    <span className="truncate text-xs text-status-danger">{key.certificateError}</span>
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
                {/* One action shows: Install on host… for a key, Set value… otherwise; the rest are behind ⋯. */}
                {key?.publicKey !== undefined ? (
                  <>
                    <Button
                      onClick={() => {
                        openInstall({ secret: secret.name });
                      }}
                    >
                      Install on host…
                    </Button>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <Button variant="ghost" className="px-1.5" aria-label={`More actions for ${secret.name}`}>
                          <MoreHorizontal size={14} aria-hidden="true" />
                        </Button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content align="end" sideOffset={4} className={MENU_CONTENT_CLASS}>
                          <DropdownMenu.Item
                            className={MENU_ITEM_CLASS}
                            onSelect={() => {
                              const publicKey = key.publicKey;
                              if (publicKey === undefined) return;
                              void navigator.clipboard.writeText(publicKey).then(() => {
                                showToast(`Copied the public key of ${secret.name}`);
                              });
                            }}
                          >
                            Copy public key
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            className={MENU_ITEM_CLASS}
                            onSelect={() => {
                              setAttaching(secret.name);
                            }}
                          >
                            {key.certificate === undefined ? 'Attach certificate…' : 'Replace certificate…'}
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            className={MENU_ITEM_CLASS}
                            onSelect={() => {
                              setForm({ name: secret.name, fixed: true, value: '' });
                            }}
                          >
                            Set value…
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </>
                ) : (
                  <Button
                    onClick={() => {
                      setForm({ name: secret.name, fixed: true, value: '' });
                    }}
                  >
                    Set value…
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {attaching !== undefined && (
        <AttachCertificateDialog
          secret={attaching}
          onClose={() => {
            setAttaching(undefined);
          }}
          onAttached={() => {
            setAttaching(undefined);
            void load();
          }}
        />
      )}
      <GenerateKeyDialog
        open={generating}
        taken={(names ?? []).map((secret) => secret.name)}
        onClose={() => {
          setGenerating(false);
        }}
        onGenerated={() => {
          setGenerating(false);
          void load();
        }}
      />
    </SshView>
  );
}

/** The saved hosts that connect to a known host's `address:port`, as its row says: "Used by box, cache +3". */
export function usedByText(entry: SshKnownHostWire, hosts: readonly ResolvedHostWire[]): string | undefined {
  const names = hosts.filter((host) => osKeyOf(host) === entry.host).map((host) => host.name);
  if (names.length === 0) return undefined;
  const more = names.length - 2;
  return `Used by ${names.slice(0, 2).join(', ')}${more > 0 ? ` +${String(more)}` : ''}`;
}

function KnownHostsPanel() {
  const [entries, setEntries] = useState<readonly SshKnownHostWire[]>();
  const [error, setError] = useState<string>();
  const [forgetting, setForgetting] = useState<SshKnownHostWire>();
  const [filter, setFilter] = useState('');
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

  const resolved = useHostsStore((s) => s.resolved);

  const forget = async (entry: SshKnownHostWire): Promise<void> => {
    const result = await ipc().ssh.forgetHostKey({ host: entry.host, keyType: entry.keyType });
    setError(result.ok ? undefined : result.error.message);
    await load();
    if (!result.ok) return;
    // Trusting the same fingerprint again puts the key back as it was (#594).
    showToast(`Forgot the ${entry.keyType} key of ${entry.host}`, {
      label: 'Undo',
      onClick: () => {
        void ipc()
          .ssh.trustHostKey({
            host: entry.host,
            keyType: entry.keyType,
            fingerprint: entry.fingerprint,
            replace: false,
          })
          .then(async (undone) => {
            setError(undone.ok ? undefined : undone.error.message);
            await load();
          });
      },
    });
  };

  const needle = filter.trim().toLowerCase();
  const shown = (entries ?? []).filter(
    (entry) =>
      needle === '' ||
      [entry.host, entry.keyType, entry.fingerprint].some((field) => field.toLowerCase().includes(needle)),
  );
  const openImport = (): void => {
    setImportOpen(true);
  };

  return (
    <SshView>
      <SshViewHeader
        title={SSH_VIEWS['known-hosts'].label}
        {...(entries === undefined ? {} : { count: entries.length })}
        search={{ value: filter, onChange: setFilter, label: 'Filter known hosts', placeholder: 'Search known hosts…' }}
        description="The host keys you trusted on this machine. Forgetting one makes the next connection to that host ask again."
        actions={
          <Button variant="primary" onClick={openImport}>
            <Download size={13} aria-hidden /> Import known hosts…
          </Button>
        }
      />
      {error !== undefined && (
        <p role="alert" className="text-sm text-status-danger">
          {error}
        </p>
      )}
      {entries === undefined ? null : entries.length === 0 ? (
        <SshEmptyState
          icon={ShieldCheck}
          text="No trusted host keys yet. The first connection to a host asks, or bring in the keys this machine already trusts."
          testId="known-hosts-empty"
        >
          <Button variant="primary" onClick={openImport}>
            <Download size={13} aria-hidden /> Import known hosts…
          </Button>
        </SshEmptyState>
      ) : shown.length === 0 ? (
        <SshNoMatches
          text="No host key matches the search."
          onClear={() => {
            setFilter('');
          }}
        />
      ) : (
        <ul
          aria-label="Known hosts"
          className="flex flex-col divide-y divide-hairline rounded-md border border-hairline"
        >
          {shown.map((entry) => (
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
                {usedByText(entry, resolved) !== undefined && (
                  <span className="truncate text-xs text-fg-subtle">{usedByText(entry, resolved)}</span>
                )}
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
    </SshView>
  );
}
