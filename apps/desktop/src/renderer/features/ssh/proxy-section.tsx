import type { SshProxyWire, SshSecretNameWire } from '../../../shared/ssh-wire.js';
import { INPUT_CLASS, sourceName, type Provenance } from './inherited-field.js';
import { SecretSelect } from './secret-fields.js';

/** This level's own `ssh.proxy`: a proxy, `false` to connect directly, `undefined` to inherit. */
export type OwnProxy = SshProxyWire | false | undefined;

type Choice = 'inherit' | 'none' | 'socks5' | 'http';

/** The port each kind of proxy listens on unless told otherwise. */
export const PROXY_DEFAULT_PORTS = { socks5: 1080, http: 3128 } as const;

const KIND_LABELS = { socks5: 'SOCKS5', http: 'HTTP CONNECT' } as const;

/** "SOCKS5 proxy.corp:1080 as alice": how the form and the details panel name a proxy. */
export function proxyText(proxy: SshProxyWire): string {
  const host = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host;
  return `${KIND_LABELS[proxy.type]} ${host}:${String(proxy.port)}${proxy.user === undefined ? '' : ` as ${proxy.user}`}`;
}

/** Why Save cannot write the proxy as it stands; `undefined` when it can. */
export function proxyProblem(own: OwnProxy): string | undefined {
  if (own === undefined || own === false) return undefined;
  if (own.host.trim() === '') return 'The proxy needs a host (Advanced)';
  if (!Number.isInteger(own.port) || own.port < 1 || own.port > 65535) {
    return 'The proxy port must be from 1 to 65535 (Advanced)';
  }
  return undefined;
}

/** A proxy with its empty optional fields dropped, so none is written as an empty string. */
export function cleanProxy(own: OwnProxy): OwnProxy {
  if (own === undefined || own === false) return own;
  const { user, passwordSecret, ...rest } = own;
  return {
    ...rest,
    host: rest.host.trim(),
    ...(user === undefined || user.trim() === '' ? {} : { user: user.trim() }),
    ...(passwordSecret === undefined || passwordSecret === '' ? {} : { passwordSecret }),
  };
}

export interface ProxySectionProps {
  readonly own: OwnProxy;
  /** What the enclosing groups set, nearest first; `false` from a group means it connects directly. */
  readonly inherited: Provenance<SshProxyWire | false>;
  readonly onChange: (next: OwnProxy) => void;
  readonly names: readonly SshSecretNameWire[];
  /** A password typed here; the form stores it as a secret on Save and keeps only the name. */
  readonly password: string;
  readonly onPasswordChange: (password: string) => void;
}

/**
 * The SOCKS5 / HTTP CONNECT proxy the host is dialled through when it is the first hop (#417). Inherited
 * whole from the nearest group; "None" under a group's proxy writes `proxy: false`.
 */
export function ProxySection({ own, inherited, onChange, names, password, onPasswordChange }: ProxySectionProps) {
  const groupProxy = typeof inherited.value === 'object' ? inherited.value : undefined;
  const choice: Choice = own === undefined ? (groupProxy ? 'inherit' : 'none') : own === false ? 'none' : own.type;
  const pick = (next: Choice): void => {
    if (next === 'inherit') onChange(undefined);
    else if (next === 'none') onChange(groupProxy ? false : undefined);
    else if (own === undefined || own === false) onChange({ type: next, host: '', port: PROXY_DEFAULT_PORTS[next] });
    else {
      // Switching kind keeps the host and login; a port left at the old default moves to the new one.
      const port = own.port === PROXY_DEFAULT_PORTS[own.type] ? PROXY_DEFAULT_PORTS[next] : own.port;
      onChange({ ...own, type: next, port });
    }
  };
  const source = typeof inherited.from === 'object' ? ` · from ${sourceName(inherited.from)}` : '';
  return (
    <fieldset aria-label="Proxy" className="flex flex-col gap-2 text-xs">
      <label className="flex flex-col gap-1">
        <span className="text-fg-subtle">Proxy</span>
        <select
          aria-label="Proxy"
          className={INPUT_CLASS}
          value={choice}
          onChange={(e) => {
            pick(e.target.value as Choice);
          }}
        >
          {groupProxy && <option value="inherit">{`Inherit: ${proxyText(groupProxy)}${source}`}</option>}
          <option value="none">{groupProxy ? 'None: connect directly' : 'None'}</option>
          <option value="socks5">SOCKS5</option>
          <option value="http">HTTP CONNECT</option>
        </select>
      </label>
      {own !== undefined && own !== false && (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-fg-subtle">Proxy host</span>
              <input
                className={INPUT_CLASS}
                value={own.host}
                placeholder="proxy.example.com"
                onChange={(e) => {
                  onChange({ ...own, host: e.target.value });
                }}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-fg-subtle">Proxy port</span>
              <input
                type="number"
                className={INPUT_CLASS}
                value={Number.isNaN(own.port) ? '' : own.port}
                onChange={(e) => {
                  onChange({ ...own, port: e.target.value === '' ? Number.NaN : Number(e.target.value) });
                }}
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-fg-subtle">Proxy user</span>
              <input
                className={INPUT_CLASS}
                value={own.user ?? ''}
                placeholder="Optional"
                onChange={(e) => {
                  const { user, ...rest } = own;
                  void user;
                  onChange(e.target.value === '' ? rest : { ...rest, user: e.target.value });
                }}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-fg-subtle">Proxy password</span>
              <input
                type="password"
                autoComplete="new-password"
                className={INPUT_CLASS}
                value={password}
                placeholder={
                  own.passwordSecret === undefined ? 'Optional' : `Stored as ${own.passwordSecret} · type to replace`
                }
                onChange={(e) => {
                  onPasswordChange(e.target.value);
                }}
              />
            </label>
          </div>
          <SecretSelect
            label="Proxy password secret"
            value={own.passwordSecret ?? ''}
            names={names}
            optional
            onChange={(name) => {
              const { passwordSecret, ...rest } = own;
              void passwordSecret;
              onChange(name === '' ? rest : { ...rest, passwordSecret: name });
            }}
          />
          <p className="text-fg-subtle">
            A typed password is kept on this machine as a secret, never in the hosts file. Only the first hop of a
            connection goes through the proxy.
          </p>
        </>
      )}
    </fieldset>
  );
}
