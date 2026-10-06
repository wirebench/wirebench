/**
 * An issued-token entry's fields (spec §4.2): the token service, the token asked for, and the
 * credential that proves who is asking — followed by the cached token's status.
 */
import type { ReactNode } from 'react';
import { SecretField } from '../../components/secret-field.js';
import { useKerberosAvailability } from '../../lib/use-kerberos-availability.js';
import { KeystorePicker, WSS_FIELD_CLASS } from './outgoing-entry-fields.js';
import { IssuedTokenStatus } from './issued-token-status.js';
import type { WssEntryWire } from '../../../shared/wire-types.js';

type IssuedEntry = Extract<WssEntryWire, { kind: 'issued-token' }>;
type Credential = IssuedEntry['credential'];

interface Props {
  readonly entry: IssuedEntry;
  readonly onChange: (entry: IssuedEntry) => void;
  readonly projectId: string;
  readonly configId: string;
  readonly entryIndex: number;
  /** The request being edited, when the editor is open in the context of one that selects this configuration. */
  readonly requestId?: string | undefined;
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="flex items-center gap-1 text-xs text-fg-subtle">
      <span className="w-24 shrink-0">{label}</span>
      {children}
    </label>
  );
}

function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-xs font-medium tracking-wider text-fg-subtle uppercase">{title}</legend>
      {children}
    </fieldset>
  );
}

/** `value` with `key` set to `next`, or dropped when `next` is undefined (`exactOptionalPropertyTypes`). */
function withOptional<T extends object, K extends keyof T>(value: T, key: K, next: T[K] | undefined): T {
  const rest = Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
  return (next === undefined ? rest : { ...rest, [key]: next }) as T;
}

/** The empty text of a field means "not set". */
function blank(text: string): string | undefined {
  return text === '' ? undefined : text;
}

function freshCredential(kind: Credential['kind']): Credential {
  if (kind === 'certificate') return { kind, keystoreRef: '' };
  if (kind === 'kerberos') return { kind, spn: '' };
  return { kind: 'username', username: '' };
}

export function IssuedTokenFields({ entry, onChange, projectId, configId, entryIndex, requestId }: Props) {
  // Undefined until main answers; Windows alone takes a typed-in account, as the engine's seam does.
  const kerberos = useKerberosAvailability();
  const set = <K extends keyof IssuedEntry>(key: K, value: IssuedEntry[K]) => {
    onChange({ ...entry, [key]: value });
  };
  const setOptional = <K extends keyof IssuedEntry>(key: K, value: IssuedEntry[K] | undefined) => {
    onChange(withOptional(entry, key, value));
  };
  const credential = entry.credential;
  const setCredential = (next: Credential) => {
    set('credential', next);
  };
  return (
    <div className="mt-1 flex flex-col gap-2">
      <Group title="Token service">
        <Row label="URL">
          <input
            aria-label="STS URL"
            className={WSS_FIELD_CLASS}
            value={entry.stsUrl}
            onChange={(e) => {
              set('stsUrl', e.target.value);
            }}
          />
        </Row>
        <Row label="SOAP version">
          <select
            aria-label="STS SOAP version"
            className={WSS_FIELD_CLASS}
            value={entry.soapVersion}
            onChange={(e) => {
              set('soapVersion', e.target.value as '1.1' | '1.2');
            }}
          >
            <option value="1.2">1.2</option>
            <option value="1.1">1.1</option>
          </select>
        </Row>
        <Row label="WS-Trust">
          <select
            aria-label="WS-Trust version"
            className={WSS_FIELD_CLASS}
            value={entry.trustVersion}
            onChange={(e) => {
              set('trustVersion', e.target.value as '1.3' | '2005-02');
            }}
          >
            <option value="1.3">1.3</option>
            <option value="2005-02">February 2005</option>
          </select>
        </Row>
        <Row label="Applies to">
          <input
            aria-label="Applies to"
            placeholder="the request's endpoint"
            className={WSS_FIELD_CLASS}
            value={entry.appliesTo ?? ''}
            onChange={(e) => {
              setOptional('appliesTo', blank(e.target.value));
            }}
          />
        </Row>
        <KeystorePicker
          label="Mutual TLS keystore"
          keystoreRef={entry.tlsKeystoreRef}
          alias={undefined}
          onChange={(ref) => {
            setOptional('tlsKeystoreRef', ref);
          }}
        />
      </Group>
      <Group title="Token">
        <Row label="SAML version">
          <select
            aria-label="Token SAML version"
            className={WSS_FIELD_CLASS}
            value={entry.tokenType}
            onChange={(e) => {
              set('tokenType', e.target.value as '1.1' | '2.0');
            }}
          >
            <option value="2.0">2.0</option>
            <option value="1.1">1.1</option>
          </select>
        </Row>
        <Row label="Key type">
          <select
            aria-label="Key type"
            className={WSS_FIELD_CLASS}
            value={entry.keyType}
            onChange={(e) => {
              set('keyType', e.target.value as 'bearer' | 'public-key');
            }}
          >
            <option value="bearer">Bearer</option>
            <option value="public-key">Public key</option>
          </select>
        </Row>
        {entry.keyType === 'public-key' && (
          <KeystorePicker
            label="Proof keystore"
            keystoreRef={entry.proofKeystoreRef}
            alias={entry.proofAlias}
            onChange={(proofKeystoreRef, proofAlias) => {
              onChange(
                withOptional(withOptional(entry, 'proofKeystoreRef', proofKeystoreRef), 'proofAlias', proofAlias),
              );
            }}
          />
        )}
        <Row label="Lifetime (s)">
          <input
            aria-label="Requested lifetime"
            type="number"
            min={0}
            className={WSS_FIELD_CLASS}
            value={entry.requestedLifetimeSeconds}
            onChange={(e) => {
              set('requestedLifetimeSeconds', Math.max(0, Number(e.target.value) || 0));
            }}
          />
        </Row>
        <textarea
          aria-label="Claims"
          placeholder="<wst:Claims …/>"
          rows={3}
          spellCheck={false}
          className={`${WSS_FIELD_CLASS} font-mono`}
          value={entry.claims ?? ''}
          onChange={(e) => {
            setOptional('claims', blank(e.target.value));
          }}
        />
      </Group>
      <Group title="Credential">
        <Row label="Credential">
          <select
            aria-label="Credential"
            className={WSS_FIELD_CLASS}
            value={credential.kind}
            onChange={(e) => {
              setCredential(freshCredential(e.target.value as Credential['kind']));
            }}
          >
            <option value="username">Username</option>
            <option value="certificate">Certificate</option>
            <option value="kerberos">Kerberos</option>
          </select>
        </Row>
        {credential.kind === 'username' && (
          <>
            <Row label="Username">
              <input
                aria-label="STS username"
                className={WSS_FIELD_CLASS}
                value={credential.username}
                onChange={(e) => {
                  setCredential({ ...credential, username: e.target.value });
                }}
              />
            </Row>
            <SecretField
              label="STS password"
              value={credential.passwordRef}
              onChange={(ref) => {
                setCredential(withOptional(credential, 'passwordRef', ref));
              }}
            />
          </>
        )}
        {credential.kind === 'certificate' && (
          <>
            <KeystorePicker
              label="Client certificate"
              keystoreRef={credential.keystoreRef === '' ? undefined : credential.keystoreRef}
              alias={credential.alias}
              onChange={(ref, alias) => {
                setCredential(withOptional({ ...credential, keystoreRef: ref ?? '' }, 'alias', alias));
              }}
            />
            <SecretField
              label="Key password"
              value={credential.keyPasswordRef}
              onChange={(ref) => {
                setCredential(withOptional(credential, 'keyPasswordRef', ref));
              }}
            />
          </>
        )}
        {credential.kind === 'kerberos' && (
          <>
            {kerberos?.available === false && kerberos.reason !== undefined && kerberos.reason !== '' && (
              <p className="text-xs text-fg-subtle">{kerberos.reason}</p>
            )}
            <Row label="SPN">
              <input
                aria-label="Service principal"
                placeholder="HTTP@sts.corp"
                className={WSS_FIELD_CLASS}
                value={credential.spn}
                onChange={(e) => {
                  setCredential({ ...credential, spn: e.target.value });
                }}
              />
            </Row>
            <Row label="Principal">
              <input
                aria-label="Principal"
                className={WSS_FIELD_CLASS}
                value={credential.principal ?? ''}
                onChange={(e) => {
                  setCredential(withOptional(credential, 'principal', blank(e.target.value)));
                }}
              />
            </Row>
            {kerberos?.platform === 'win32' && (
              <>
                <Row label="Username">
                  <input
                    aria-label="Kerberos username"
                    className={WSS_FIELD_CLASS}
                    value={credential.username ?? ''}
                    onChange={(e) => {
                      setCredential(withOptional(credential, 'username', blank(e.target.value)));
                    }}
                  />
                </Row>
                <Row label="Domain">
                  <input
                    aria-label="Kerberos domain"
                    className={WSS_FIELD_CLASS}
                    value={credential.domain ?? ''}
                    onChange={(e) => {
                      setCredential(withOptional(credential, 'domain', blank(e.target.value)));
                    }}
                  />
                </Row>
                <SecretField
                  label="Kerberos password"
                  value={credential.passwordRef}
                  onChange={(ref) => {
                    setCredential(withOptional(credential, 'passwordRef', ref));
                  }}
                />
              </>
            )}
          </>
        )}
      </Group>
      <IssuedTokenStatus
        projectId={projectId}
        configId={configId}
        entryIndex={entryIndex}
        requestId={requestId}
        revision={JSON.stringify(entry)}
      />
    </div>
  );
}
