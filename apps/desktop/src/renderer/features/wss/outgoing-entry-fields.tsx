/**
 * The per-kind field blocks for one WS-Security entry row: everything below the row header in
 * {@link EntryRow} of `outgoing-config-editor.tsx`. Split out because the parent file mixes
 * three unrelated concerns (the config list, one config's editor, one entry's fields); this file
 * owns only the third.
 */

import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { IconButton } from '../../components/icon-button.js';
import { SecretField } from '../../components/secret-field.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import type { KeystoreAliasWire, WssEntryWire } from '../../../shared/wire-types.js';

type WssTimestampEntry = Extract<WssEntryWire, { kind: 'timestamp' }>;
type WssUsernameTokenEntry = Extract<WssEntryWire, { kind: 'username-token' }>;
type WssSignatureEntry = Extract<WssEntryWire, { kind: 'signature' }>;
type WssEncryptionEntry = Extract<WssEntryWire, { kind: 'encryption' }>;
type WssPartWire = WssSignatureEntry['parts'][number];

/** Tailwind classes shared by every text/number/select field in the WS-Security editor. */
export const WSS_FIELD_CLASS =
  'w-full rounded border border-hairline bg-surface-sunken px-1 py-0.5 text-xs text-fg-default';

interface TimestampFieldsProps {
  readonly entry: WssTimestampEntry;
  readonly onChange: (entry: WssTimestampEntry) => void;
}

/** The `wsu:Timestamp` entry's fields: time-to-live and millisecond precision. */
export function TimestampFields({ entry, onChange }: TimestampFieldsProps) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <span className="w-24 shrink-0">Time to live (s)</span>
        <input
          type="number"
          min={0}
          aria-label="Time to live (seconds)"
          className={WSS_FIELD_CLASS}
          value={entry.timeToLiveSeconds}
          onChange={(event) => {
            onChange({ ...entry, timeToLiveSeconds: Math.max(0, Number(event.target.value) || 0) });
          }}
        />
      </label>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <input
          type="checkbox"
          checked={entry.millisecondPrecision}
          onChange={(event) => {
            onChange({ ...entry, millisecondPrecision: event.target.checked });
          }}
        />
        Millisecond precision
      </label>
    </div>
  );
}

interface UsernameTokenFieldsProps {
  readonly entry: WssUsernameTokenEntry;
  readonly onChange: (entry: WssUsernameTokenEntry) => void;
}

/** The `wsse:UsernameToken` entry's fields: username, password type/secret, nonce/created. */
export function UsernameTokenFields({ entry, onChange }: UsernameTokenFieldsProps) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <span className="w-24 shrink-0">Username</span>
        <input
          aria-label="Username"
          className={WSS_FIELD_CLASS}
          value={entry.username}
          onChange={(event) => {
            onChange({ ...entry, username: event.target.value });
          }}
        />
      </label>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <span className="w-24 shrink-0">Password type</span>
        <select
          aria-label="Password type"
          className={WSS_FIELD_CLASS}
          value={entry.passwordType}
          onChange={(event) => {
            onChange({ ...entry, passwordType: event.target.value as 'text' | 'digest' | 'none' });
          }}
        >
          <option value="digest">Digest</option>
          <option value="text">Text</option>
          <option value="none">None</option>
        </select>
      </label>
      <div data-testid="wss-entry-password">
        <SecretField
          label="WS-Security password"
          value={entry.passwordRef}
          onChange={(ref) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
            const { passwordRef: dropped, ...rest } = entry;
            onChange(ref === undefined ? rest : { ...rest, passwordRef: ref });
          }}
        />
      </div>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <input
          type="checkbox"
          checked={entry.addNonce}
          onChange={(event) => {
            onChange({ ...entry, addNonce: event.target.checked });
          }}
        />
        Add nonce
      </label>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <input
          type="checkbox"
          checked={entry.addCreated}
          onChange={(event) => {
            onChange({ ...entry, addCreated: event.target.checked });
          }}
        />
        Add created
      </label>
    </div>
  );
}

interface PartsTableProps {
  /** The `aria-label` of the list, so a Signature's and an Encryption's tables stay distinguishable. */
  readonly label: string;
  /** What to say when the list is empty. */
  readonly empty: string;
  readonly parts: readonly WssPartWire[];
  readonly onChange: (parts: readonly WssPartWire[]) => void;
}

/** The Parts table both the Signature and the Encryption entries edit. */
function PartsTable({ label, empty, parts, onChange }: PartsTableProps) {
  return (
    <>
      <div className="mt-1 flex items-center gap-1">
        <span className="min-w-0 flex-1 text-xs font-medium tracking-wider text-fg-subtle uppercase">Parts</span>
        <IconButton
          label="Add part"
          data-testid="wss-part-add"
          onClick={() => {
            onChange([...parts, { name: '', namespace: '', encode: 'Content' }]);
          }}
        >
          <Plus size={12} aria-hidden="true" />
        </IconButton>
      </div>
      <ul aria-label={label} className="flex flex-col gap-1">
        {parts.length === 0 && <li className="text-xs text-fg-faint">{empty}</li>}
        {parts.map((part, index) => (
          <li key={`${part.namespace}-${part.name}-${String(index)}`} data-testid="wss-part-row" className="flex gap-1">
            <input
              aria-label={`Part ${String(index + 1)} name`}
              className={WSS_FIELD_CLASS}
              value={part.name}
              onChange={(event) => {
                onChange(
                  parts.map((candidate, at) => (at === index ? { ...candidate, name: event.target.value } : candidate)),
                );
              }}
            />
            <input
              aria-label={`Part ${String(index + 1)} namespace`}
              className={WSS_FIELD_CLASS}
              value={part.namespace}
              onChange={(event) => {
                onChange(
                  parts.map((candidate, at) =>
                    at === index ? { ...candidate, namespace: event.target.value } : candidate,
                  ),
                );
              }}
            />
            <select
              aria-label={`Part ${String(index + 1)} encode`}
              className={WSS_FIELD_CLASS}
              value={part.encode}
              onChange={(event) => {
                onChange(
                  parts.map((candidate, at) =>
                    at === index ? { ...candidate, encode: event.target.value as WssPartWire['encode'] } : candidate,
                  ),
                );
              }}
            >
              <option value="Content">Content</option>
              <option value="Element">Element</option>
            </select>
            <IconButton
              label={`Remove part ${String(index + 1)}`}
              onClick={() => {
                onChange(parts.filter((_candidate, at) => at !== index));
              }}
            >
              <Trash2 size={12} aria-hidden="true" />
            </IconButton>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The five X.509 token profile forms, with the label the editor shows for each. */
const KEY_IDENTIFIER_OPTIONS: readonly (readonly [WssSignatureEntry['keyIdentifierType'], string])[] = [
  ['BinarySecurityToken', 'Binary Security Token'],
  ['IssuerSerial', 'Issuer Name and Serial Number'],
  ['SubjectKeyIdentifier', 'Subject Key Identifier'],
  ['X509KeyIdentifier', 'X509 Certificate'],
  ['Thumbprint', 'Thumbprint SHA-1'],
];

interface SignatureFieldsProps {
  readonly entry: WssSignatureEntry;
  readonly onChange: (entry: WssSignatureEntry) => void;
}

/**
 * The `ds:Signature` entry's fields: the signing keystore and alias, how the certificate is
 * referenced, the algorithms, and the parts table.
 *
 * The alias list comes from `keystores.inspect` — main reads the keystore; the renderer only
 * ever sees alias names and certificate metadata, never a key.
 */
/**
 * The alias names of one keystore, loaded through `keystores.inspect` — main reads the
 * keystore; the renderer only ever sees alias names and certificate metadata, never a key.
 */
function useKeystoreAliases(keystoreRef: string): readonly KeystoreAliasWire[] {
  const [aliases, setAliases] = useState<readonly KeystoreAliasWire[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (keystoreRef === '') {
      setAliases([]);
      return undefined;
    }
    void (async () => {
      try {
        const result = await ipc().keystores.inspect({ keystoreId: keystoreRef });
        if (!cancelled) {
          setAliases(result.ok ? result.value.aliases : []);
        }
      } catch {
        if (!cancelled) {
          setAliases([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [keystoreRef]);

  return aliases;
}

export function SignatureFields({ entry, onChange }: SignatureFieldsProps) {
  const keystores = useProjectStore((state) => state.keystores);
  const aliases = useKeystoreAliases(entry.keystoreRef);

  const setParts = (parts: readonly WssPartWire[]): void => {
    onChange({ ...entry, parts: [...parts] });
  };

  return (
    <div className="mt-1 flex flex-col gap-1" data-testid="wss-signature-fields">
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <span className="w-24 shrink-0">Keystore</span>
        <select
          aria-label="Signature keystore"
          className={WSS_FIELD_CLASS}
          value={entry.keystoreRef}
          onChange={(event) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
            const { alias: dropped, ...rest } = entry;
            onChange({ ...rest, keystoreRef: event.target.value });
          }}
        >
          <option value="">—</option>
          {keystores.map((keystore) => (
            <option key={keystore.id} value={keystore.id}>
              {keystore.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <span className="w-24 shrink-0">Alias</span>
        <select
          aria-label="Signature alias"
          className={WSS_FIELD_CLASS}
          value={entry.alias ?? ''}
          onChange={(event) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
            const { alias: dropped, ...rest } = entry;
            onChange(event.target.value === '' ? rest : { ...rest, alias: event.target.value });
          }}
        >
          <option value="">Default</option>
          {aliases.map((alias) => (
            <option key={alias.alias} value={alias.alias}>
              {alias.alias}
            </option>
          ))}
          {entry.alias !== undefined && !aliases.some((alias) => alias.alias === entry.alias) && (
            <option value={entry.alias}>{entry.alias}</option>
          )}
        </select>
      </label>
      <div data-testid="wss-signature-key-password">
        <SecretField
          label="Signing key password"
          value={entry.keyPasswordRef}
          onChange={(ref) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
            const { keyPasswordRef: dropped, ...rest } = entry;
            onChange(ref === undefined ? rest : { ...rest, keyPasswordRef: ref });
          }}
        />
      </div>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <span className="w-24 shrink-0">Key identifier</span>
        <select
          aria-label="Key identifier type"
          className={WSS_FIELD_CLASS}
          value={entry.keyIdentifierType}
          onChange={(event) => {
            onChange({ ...entry, keyIdentifierType: event.target.value as WssSignatureEntry['keyIdentifierType'] });
          }}
        >
          {KEY_IDENTIFIER_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <span className="w-24 shrink-0">Signature</span>
        <select
          aria-label="Signature algorithm"
          className={WSS_FIELD_CLASS}
          value={entry.signatureAlgorithm}
          onChange={(event) => {
            onChange({ ...entry, signatureAlgorithm: event.target.value as WssSignatureEntry['signatureAlgorithm'] });
          }}
        >
          <option value="rsa-sha256">RSA-SHA256</option>
          <option value="rsa-sha1">RSA-SHA1</option>
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <span className="w-24 shrink-0">Digest</span>
        <select
          aria-label="Digest algorithm"
          className={WSS_FIELD_CLASS}
          value={entry.digestAlgorithm}
          onChange={(event) => {
            onChange({ ...entry, digestAlgorithm: event.target.value as WssSignatureEntry['digestAlgorithm'] });
          }}
        >
          <option value="sha256">SHA-256</option>
          <option value="sha1">SHA-1</option>
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <input
          type="checkbox"
          aria-label="Use single certificate"
          checked={entry.useSingleCertificate}
          onChange={(event) => {
            onChange({ ...entry, useSingleCertificate: event.target.checked });
          }}
        />
        Use single certificate
      </label>

      <PartsTable
        label="Signed parts"
        empty="No parts — nothing would be signed."
        parts={entry.parts}
        onChange={setParts}
      />
    </div>
  );
}

/** The symmetric algorithms this build encrypts message parts with. */
const SYMMETRIC_OPTIONS: readonly (readonly [WssEncryptionEntry['symmetricAlgorithm'], string])[] = [
  ['aes256-gcm', 'AES-256 GCM'],
  ['aes128-gcm', 'AES-128 GCM'],
  ['aes256-cbc', 'AES-256 CBC'],
  ['aes128-cbc', 'AES-128 CBC'],
];

interface EncryptionFieldsProps {
  readonly entry: WssEncryptionEntry;
  readonly onChange: (entry: WssEncryptionEntry) => void;
}

/**
 * The `xenc:EncryptedKey`/`xenc:EncryptedData` entry's fields: whose certificate the message is
 * encrypted to, how it is referenced, the algorithms, and the parts table.
 *
 * Only the recipient's *certificate* is used, so the alias this names needs no private key —
 * which is why, unlike the Signature entry, there is no key-password field here.
 */
export function EncryptionFields({ entry, onChange }: EncryptionFieldsProps) {
  const keystores = useProjectStore((state) => state.keystores);
  const aliases = useKeystoreAliases(entry.keystoreRef);

  return (
    <div className="mt-1 flex flex-col gap-1" data-testid="wss-encryption-fields">
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <span className="w-24 shrink-0">Keystore</span>
        <select
          aria-label="Encryption keystore"
          className={WSS_FIELD_CLASS}
          value={entry.keystoreRef}
          onChange={(event) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
            const { alias: dropped, ...rest } = entry;
            onChange({ ...rest, keystoreRef: event.target.value });
          }}
        >
          <option value="">—</option>
          {keystores.map((keystore) => (
            <option key={keystore.id} value={keystore.id}>
              {keystore.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <span className="w-24 shrink-0">Alias</span>
        <select
          aria-label="Encryption alias"
          className={WSS_FIELD_CLASS}
          value={entry.alias ?? ''}
          onChange={(event) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
            const { alias: dropped, ...rest } = entry;
            onChange(event.target.value === '' ? rest : { ...rest, alias: event.target.value });
          }}
        >
          <option value="">Default</option>
          {aliases.map((alias) => (
            <option key={alias.alias} value={alias.alias}>
              {alias.alias}
            </option>
          ))}
          {entry.alias !== undefined && !aliases.some((alias) => alias.alias === entry.alias) && (
            <option value={entry.alias}>{entry.alias}</option>
          )}
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <span className="w-24 shrink-0">Key identifier</span>
        <select
          aria-label="Encryption key identifier type"
          className={WSS_FIELD_CLASS}
          value={entry.keyIdentifierType}
          onChange={(event) => {
            onChange({ ...entry, keyIdentifierType: event.target.value as WssEncryptionEntry['keyIdentifierType'] });
          }}
        >
          {KEY_IDENTIFIER_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <span className="w-24 shrink-0">Encryption</span>
        <select
          aria-label="Encryption algorithm"
          className={WSS_FIELD_CLASS}
          value={entry.symmetricAlgorithm}
          onChange={(event) => {
            onChange({ ...entry, symmetricAlgorithm: event.target.value as WssEncryptionEntry['symmetricAlgorithm'] });
          }}
        >
          {SYMMETRIC_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <span className="w-24 shrink-0">Key transport</span>
        <select
          aria-label="Key transport algorithm"
          className={WSS_FIELD_CLASS}
          value={entry.keyTransportAlgorithm}
          onChange={(event) => {
            onChange({
              ...entry,
              keyTransportAlgorithm: event.target.value as WssEncryptionEntry['keyTransportAlgorithm'],
            });
          }}
        >
          <option value="rsa-oaep">RSA-OAEP (MGF1-SHA1)</option>
          <option value="rsa-1_5">RSA 1.5</option>
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <input
          type="checkbox"
          aria-label="Embed key"
          checked={entry.embedKey}
          onChange={(event) => {
            onChange({ ...entry, embedKey: event.target.checked });
          }}
        />
        Embed certificate as a Binary Security Token
      </label>
      <p className="text-xs text-fg-subtle">
        The symmetric key is always encrypted to the recipient certificate. Out-of-band symmetric keys are not supported
        yet.
      </p>

      <PartsTable
        label="Encrypted parts"
        empty="No parts — nothing would be encrypted."
        parts={entry.parts}
        onChange={(parts) => {
          onChange({ ...entry, parts: [...parts] });
        }}
      />
    </div>
  );
}
