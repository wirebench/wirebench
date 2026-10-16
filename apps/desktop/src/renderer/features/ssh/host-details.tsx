/**
 * The selected host, in the right slide-over (where the Code panel shows for a request): how it
 * connects and where each setting comes from, how it signs in and whether that secret has a value
 * here, the host key trusted for it, and the `ssh` command that matches. The right rail's icon (and Edit)
 * opens it; the rail's icon, its close icon and Escape put it away. Selecting a card neither opens nor
 * closes it, it only changes the host shown. Whether it shows is remembered on this machine.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Copy, FolderOpen, Pencil, TriangleAlert } from 'lucide-react';
import { Button } from '../../components/button.js';
import type { ResolvedHostWire, SshKnownHostWire, SshSecretNameWire } from '../../../shared/ssh-wire.js';
import { useEditorsStore } from '../../state/editors.js';
import { useUiStore } from '../../state/ui.js';
import { ipc } from '../../state/ipc-client.js';
import { editHost, openTerminalFor } from './connect.js';
import { openFiles } from './files/open-files.js';
import { HostForwards } from './forwarding/forwarding-view.js';
import { isLive, useForwardsStore } from './forwarding/forwards-store.js';
import { HostForm } from './host-dialog.js';
import { HostActionsButton } from './host-menus.js';
import { findHost, flattenGroups, hostStatusOf, osKeyOf, useHostsStore } from './hosts-store.js';
import { OsIcon, osOf, osTextOf } from './os-icon.js';
import { ProtectedMark } from './protected-mark.js';
import { proxyText } from './proxy-section.js';
import { HostSessionLogs } from './session-logs.js';
import { sessionStatus } from './session-status.js';
import { schemeLabel } from './terminal-schemes.js';

/**
 * Whether the details slide-over is in front: the Hosts tab is showing and the panel was not put away.
 * With no host picked (after a restart, say) it still shows, and asks for one.
 */
export function useHostDetailsShown(): boolean {
  const homeInFront = useEditorsStore((s) => s.displayedSet === 'ssh' && s.activeId === undefined);
  const onHosts = useHostsStore((s) => s.homeView === 'hosts');
  const open = useUiStore((s) => s.slideOver.hostDetailsOpen === true);
  return homeInFront && onHosts && open;
}

type Provenance = ResolvedHostWire['ssh']['port']['from'];

export function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    // The label above the value in a panel narrower than 360px, beside it from there.
    <div className="grid grid-cols-1 items-baseline gap-x-2 gap-y-0.5 py-1 @min-[360px]:grid-cols-[6.5rem_1fr]">
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="flex min-w-0 items-baseline gap-2 text-sm text-fg-default">{children}</dd>
    </div>
  );
}

export function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col border-t border-hairline px-1 py-3">
      <h3 className="mb-1 text-xs font-medium tracking-wider text-fg-subtle uppercase">{title}</h3>
      <dl>{children}</dl>
    </section>
  );
}

export function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard.writeText(text);
      }}
      className="ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg-default"
    >
      <Copy size={12} aria-hidden="true" />
    </button>
  );
}

/** The `ssh` command line that reaches the host as configured, leaving out what is the default. */
export function sshCommandOf(host: ResolvedHostWire, jumpAddress: string | undefined): string {
  const parts = ['ssh'];
  const port = host.ssh.port.value;
  if (port !== 22) parts.push('-p', String(port));
  if (host.ssh.forwardAgent.value) parts.push('-A');
  if (jumpAddress !== undefined) parts.push('-J', jumpAddress);
  // Only a first hop is dialled through its proxy; with a jump host, the jump host's own proxy applies.
  const proxy = host.ssh.proxy.value;
  if (proxy !== undefined && jumpAddress === undefined) {
    const host = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host;
    const login = proxy.type === 'http' && proxy.user !== undefined ? ` -P ${proxy.user}` : '';
    const version = proxy.type === 'socks5' ? '5' : 'connect';
    parts.push('-o', `"ProxyCommand=nc -X ${version} -x ${host}:${String(proxy.port)}${login} %h %p"`);
  }
  const user = host.ssh.user.value;
  parts.push(user === undefined ? host.address : `${user}@${host.address}`);
  return parts.join(' ');
}

export function HostDetails() {
  const selectedHostId = useHostsStore((s) => s.selectedHostId);
  const file = useHostsStore((s) => s.file);
  const resolved = useHostsStore((s) => s.resolved);
  const dialog = useHostsStore((s) => s.dialog);
  const hostStatus = useHostsStore((s) =>
    selectedHostId === undefined ? undefined : hostStatusOf(s.panes, selectedHostId),
  );
  const osByHost = useHostsStore((s) => s.osByHost);
  // The live forwards through the host, so a host with no terminal open still says it is in use (#594).
  const forwardsRunning = useForwardsStore((s) =>
    selectedHostId === undefined
      ? 0
      : Object.entries(s.byKey).filter(([key, state]) => key.startsWith(`${selectedHostId}/`) && isLive(state)).length,
  );
  const [knownHosts, setKnownHosts] = useState<readonly SshKnownHostWire[]>([]);
  const [secrets, setSecrets] = useState<readonly SshSecretNameWire[]>([]);

  // Read again per host: a key may have been trusted, or a secret stored, since the last one.
  useEffect(() => {
    void (async () => {
      const [known, names] = await Promise.all([ipc().ssh.knownHosts(undefined), ipc().ssh.secretNames(undefined)]);
      setKnownHosts(known.ok ? known.value.entries : []);
      setSecrets(names.ok ? names.value.names : []);
    })();
  }, [selectedHostId, hostStatus]);

  const entry = selectedHostId === undefined ? undefined : findHost(file, selectedHostId);
  if (entry === undefined) {
    return (
      <p data-testid="host-details-empty" className="px-1 py-3 text-sm text-fg-subtle">
        Select a host to see its details.
      </p>
    );
  }
  if (dialog?.mode === 'edit-host' && dialog.id === entry.id) {
    return (
      <div data-testid="host-edit" className="px-1 py-3">
        <HostForm key={entry.id} file={file} dialog={dialog} embedded />
      </div>
    );
  }
  const host = resolved.find((h) => h.id === entry.id);
  const groups = flattenGroups(file);
  const groupName = (id: string): string => groups.find(({ group }) => group.id === id)?.group.name ?? id;
  const status = sessionStatus(hostStatus);
  const identityName = (id: string): string => file.identities?.find((i) => i.id === id)?.name ?? id;
  const provenance = (from: Provenance | { identity: string }): string =>
    from === 'host'
      ? 'set on host'
      : from === 'preferences'
        ? 'from Preferences'
        : from === 'default'
          ? 'default'
          : 'identity' in from
            ? `from identity ${identityName(from.identity)}`
            : `from ${groupName(from.group)}`;
  const path = host?.path.map(groupName).join(' / ');

  const edit = (): void => {
    editHost(entry.id);
  };

  const header = (
    <div className="flex flex-col gap-3 px-1 py-3">
      <div className="flex min-w-0 flex-col">
        <h2 className="flex min-w-0 items-center gap-1.5 text-md font-medium text-fg-default">
          <span className="truncate">{entry.name}</span>
          {host?.protected.value === true && <ProtectedMark size={14} />}
        </h2>
        <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
          <span className={`size-2 shrink-0 rounded-full bg-current ${status.color}`} aria-hidden="true" />
          <span>{status.label}</span>
          {forwardsRunning > 0 && (
            <>
              <span>·</span>
              <button
                type="button"
                data-testid="host-details-forwards"
                title="Show Port forwarding"
                className="shrink-0 rounded text-accent hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
                onClick={() => {
                  useHostsStore.getState().setHomeView('forwarding');
                }}
              >
                {`${String(forwardsRunning)} forward${forwardsRunning === 1 ? '' : 's'} running`}
              </button>
            </>
          )}
          {path !== undefined && path !== '' && <span className="truncate">· {path}</span>}
        </p>
      </div>
      {/* Wraps in a narrow panel rather than pushing the last buttons past its edge. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          onClick={() => {
            openTerminalFor(entry.id);
          }}
        >
          Connect
        </Button>
        <Button
          onClick={() => {
            openFiles(entry.id);
          }}
        >
          <FolderOpen size={12} aria-hidden="true" /> Files
        </Button>
        <Button onClick={edit}>
          <Pencil size={12} aria-hidden="true" /> Edit
        </Button>
        <HostActionsButton host={entry} className="ml-auto" />
      </div>
    </div>
  );

  if (host === undefined) {
    return (
      <div data-testid="host-details" className="flex flex-col">
        {header}
        <p className="border-t border-hairline px-1 py-3 text-sm text-fg-subtle">
          This host could not be resolved; see the problems above the cards.
        </p>
      </div>
    );
  }

  const auth = host.ssh.auth.value;
  const secretState = (name: string): string => {
    const found = secrets.find((s) => s.name === name);
    if (found === undefined || (!found.local && !found.external)) return 'no value on this machine';
    return found.local ? 'value on this machine' : 'from a secret source';
  };
  const jump = host.ssh.jump.value;
  const jumpHost = jump === undefined ? undefined : resolved.find((h) => h.id === jump);
  const jumpAddress =
    jump === undefined
      ? undefined
      : jumpHost === undefined
        ? jump
        : `${jumpHost.ssh.user.value === undefined ? '' : `${jumpHost.ssh.user.value}@`}${jumpHost.address}${
            jumpHost.ssh.port.value === 22 ? '' : `:${String(jumpHost.ssh.port.value)}`
          }`;
  const hostKey = `${host.address}:${String(host.ssh.port.value)}`;
  const keys = knownHosts.filter((k) => k.host === hostKey);
  const command = sshCommandOf(host, jumpAddress);
  const proxy = host.ssh.proxy.value;
  const muted = (text: string): ReactNode => <span className="truncate text-xs text-fg-subtle">{text}</span>;
  const osEntry = osByHost[osKeyOf(host)];
  const os = osOf(osEntry);

  return (
    <div data-testid="host-details" className="flex flex-col">
      {header}
      {host.incomplete !== undefined && (
        <div
          role="alert"
          className="mx-1 mb-3 flex items-center gap-2 rounded-md border border-status-warning px-3 py-2 text-sm text-fg-default"
        >
          <TriangleAlert size={14} aria-hidden="true" className="shrink-0 text-status-warning" />
          <span className="flex-1">
            {host.incomplete.field === 'user' ? 'Needs a user to connect.' : 'Needs a way to sign in.'}
          </span>
          <Button className="h-6 px-2 text-xs" onClick={edit}>
            Edit
          </Button>
        </div>
      )}
      <Section title="Connection">
        <Row label="Address">
          <span className="truncate font-mono">{host.address}</span>
          <CopyButton text={host.address} label="Copy address" />
        </Row>
        <Row label="Port">
          <span className="font-mono">{host.ssh.port.value}</span>
          {muted(provenance(host.ssh.port.from))}
        </Row>
        <Row label="User">
          <span className="truncate font-mono">{host.ssh.user.value ?? '—'}</span>
          {host.ssh.user.value !== undefined && muted(provenance(host.ssh.user.from))}
        </Row>
        <Row label="OS">
          {os === undefined ? (
            <span className="text-fg-subtle">found on the first connection</span>
          ) : (
            <>
              <span className="flex min-w-0 items-center gap-1.5 self-center">
                <OsIcon os={os} size={14} />
                <span className="truncate">{osTextOf(osEntry)}</span>
              </span>
              {muted(osEntry?.chosen === undefined ? 'detected' : 'set by you')}
            </>
          )}
        </Row>
        <Row label="Protocol">
          <span>{host.ssh.protocol?.value === 'mosh' ? 'Mosh' : 'SSH'}</span>
          {host.ssh.protocol !== undefined &&
            host.ssh.protocol.from !== 'default' &&
            muted(provenance(host.ssh.protocol.from))}
        </Row>
        {host.ssh.protocol?.value === 'mosh' && (
          <Row label="Mosh server">
            <span className="truncate font-mono">
              {[host.ssh.mosh?.value?.server ?? 'mosh-server', host.ssh.mosh?.value?.ports]
                .filter(Boolean)
                .join(' · UDP ')}
            </span>
          </Row>
        )}
        <Row label="Jump host">
          <span className="truncate">{jump === undefined ? '—' : (jumpHost?.name ?? jump)}</span>
          {jump !== undefined && muted(provenance(host.ssh.jump.from))}
        </Row>
        <Row label="Proxy">
          <span className="truncate">{proxy === undefined ? '—' : proxyText(proxy)}</span>
          {(proxy !== undefined || host.ssh.proxy.from !== 'default') && muted(provenance(host.ssh.proxy.from))}
          {proxy !== undefined && jump !== undefined && muted('not used: reached through the jump host')}
        </Row>
        {proxy?.passwordSecret !== undefined && (
          <Row label="Proxy password">
            <span className="truncate font-mono">{proxy.passwordSecret}</span>
            {muted(secretState(proxy.passwordSecret))}
          </Row>
        )}
      </Section>
      <Section title="Sign-in">
        {auth === undefined ? (
          <Row label="Method">
            <span className="text-fg-subtle">not set</span>
          </Row>
        ) : (
          <>
            <Row label="Method">
              <span>{auth.kind === 'agent' ? 'SSH agent' : auth.kind === 'key' ? 'Private key' : 'Password'}</span>
              {muted(provenance(host.ssh.auth.from))}
            </Row>
            {auth.kind !== 'agent' && (
              <Row label={auth.kind === 'key' ? 'Key secret' : 'Secret'}>
                <span className="truncate font-mono">{auth.secret}</span>
                {muted(secretState(auth.secret))}
              </Row>
            )}
            {auth.kind === 'key' && auth.certificateSecret !== undefined && (
              <Row label="Certificate">
                <span className="truncate font-mono">{auth.certificateSecret}</span>
                {muted(secretState(auth.certificateSecret))}
              </Row>
            )}
            {auth.kind === 'key' && auth.passphraseSecret !== undefined && (
              <Row label="Passphrase">
                <span className="truncate font-mono">{auth.passphraseSecret}</span>
                {muted(secretState(auth.passphraseSecret))}
              </Row>
            )}
          </>
        )}
      </Section>
      <Section title="Agent">
        <Row label="Agent forwarding">
          <span>{host.ssh.forwardAgent.value ? 'On' : 'Off'}</span>
          {muted(provenance(host.ssh.forwardAgent.from))}
        </Row>
      </Section>
      <Section title="Host key">
        {keys.length === 0 ? (
          <p className="py-1 text-sm text-fg-subtle">Not trusted yet: the first connection asks.</p>
        ) : (
          keys.map((key) => (
            <Row key={key.keyType} label={key.keyType}>
              <span className="font-mono text-xs break-all">{key.fingerprint}</span>
            </Row>
          ))
        )}
      </Section>
      {host.env.length > 0 && (
        <Section title="Environment">
          {host.env.map((variable) => (
            <Row key={variable.name} label={variable.name}>
              {variable.secret === undefined ? (
                <span className="truncate font-mono">{variable.value}</span>
              ) : (
                <>
                  <span className="truncate font-mono">{variable.secret}</span>
                  {muted(secretState(variable.secret))}
                </>
              )}
              {muted(provenance(variable.from))}
            </Row>
          ))}
        </Section>
      )}
      {host.terminal !== undefined &&
        (host.terminal.scheme.value !== undefined || host.terminal.fontSize.value !== undefined) && (
          <Section title="Terminal">
            {host.terminal.scheme.value !== undefined && (
              <Row label="Scheme">
                <span className="truncate">{schemeLabel(host.terminal.scheme.value)}</span>
                {muted(provenance(host.terminal.scheme.from))}
              </Row>
            )}
            {host.terminal.fontSize.value !== undefined && (
              <Row label="Font size">
                <span>{`${String(host.terminal.fontSize.value)} px`}</span>
                {muted(provenance(host.terminal.fontSize.from))}
              </Row>
            )}
          </Section>
        )}
      <section aria-label="Port forwarding" className="flex flex-col border-t border-hairline px-1 py-3">
        <h3 className="mb-1 text-xs font-medium tracking-wider text-fg-subtle uppercase">Port forwarding</h3>
        <HostForwards hostId={host.id} />
      </section>
      <HostSessionLogs hostId={host.id} path={host.path} groupName={groupName} refreshKey={hostStatus} />
      <Section title="Timing">
        <Row label="Keep-alive">
          <span>{host.ssh.keepAlive.value}s</span>
          {muted(provenance(host.ssh.keepAlive.from))}
        </Row>
        <Row label="Timeout">
          <span>{host.ssh.connectTimeout.value}s</span>
          {muted(provenance(host.ssh.connectTimeout.from))}
        </Row>
      </Section>
      {host.tags.length > 0 && (
        <Section title="Tags">
          <div className="flex flex-wrap gap-1 py-1">
            {host.tags.map((tag) => (
              <span key={tag} className="rounded-full border border-hairline px-2 text-xs text-fg-subtle">
                {tag}
              </span>
            ))}
          </div>
        </Section>
      )}
      <Section title="Command">
        <div className="flex items-start gap-2 rounded-md bg-surface-sunken px-2 py-1.5">
          <code className="min-w-0 flex-1 font-mono text-xs break-all text-fg-default">{command}</code>
          <CopyButton text={command} label="Copy command" />
        </div>
      </Section>
    </div>
  );
}
