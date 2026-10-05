/**
 * A SAML token entry's fields: Form (build an assertion) or XML (supply one). The assertion
 * itself never crosses to main as anything but this entry: main builds or reads it at send.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { IconButton } from '../../components/icon-button.js';
import { SecretField } from '../../components/secret-field.js';
import { KeystorePicker, WSS_FIELD_CLASS } from './outgoing-entry-fields.js';
import type { WssEntryWire } from '../../../shared/wire-types.js';

type SamlEntry = Extract<WssEntryWire, { kind: 'saml-token' }>;
type SamlSign = NonNullable<SamlEntry['sign']>;

interface Props {
  readonly entry: SamlEntry;
  readonly onChange: (entry: SamlEntry) => void;
  /** Unique per entry row: the radio group's `name`. */
  readonly idPrefix: string;
}

/** A fresh form entry: SAML 2.0 bearer, five minutes. */
export function newSamlFormEntry(): SamlEntry {
  return {
    kind: 'saml-token',
    source: 'form',
    version: '2.0',
    issuer: '',
    subject: '',
    confirmation: 'bearer',
    lifetimeSeconds: 300,
    attributes: [],
  };
}

export function newSamlXmlEntry(): SamlEntry {
  return { kind: 'saml-token', source: 'xml', xml: '', expandProperties: false };
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="flex items-center gap-1 text-xs text-fg-subtle">
      <span className="w-24 shrink-0">{label}</span>
      {children}
    </label>
  );
}

type TextKey = 'issuer' | 'subject' | 'subjectFormat' | 'audience' | 'authnContext';

function SigningFields({
  entry,
  sign,
  onChange,
}: {
  readonly entry: SamlEntry;
  readonly sign: SamlSign;
  readonly onChange: Props['onChange'];
}) {
  return (
    <>
      <KeystorePicker
        label="Issuer keystore"
        keystoreRef={sign.keystoreRef === '' ? undefined : sign.keystoreRef}
        alias={sign.alias}
        onChange={(keystoreRef, alias) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
          const { alias: dropped, ...rest } = sign;
          onChange({
            ...entry,
            sign: { ...rest, keystoreRef: keystoreRef ?? '', ...(alias !== undefined ? { alias } : {}) },
          });
        }}
      />
      <SecretField
        label="Issuer key password"
        value={sign.keyPasswordRef}
        onChange={(ref) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
          const { keyPasswordRef: dropped, ...rest } = sign;
          onChange({ ...entry, sign: { ...rest, ...(ref !== undefined ? { keyPasswordRef: ref } : {}) } });
        }}
      />
    </>
  );
}

/**
 * A comma-separated values field. The raw text stays local while it is edited (so "Domain " keeps
 * its space) and is split and trimmed on blur; it re-syncs when the values change from outside.
 */
function AttributeValuesInput(props: {
  readonly label: string;
  readonly values: readonly string[];
  readonly onCommit: (values: string[]) => void;
}) {
  const joined = props.values.join(', ');
  const [text, setText] = useState(joined);
  useEffect(() => {
    setText(joined);
  }, [joined]);
  return (
    <input
      aria-label={props.label}
      placeholder="value, value"
      className={WSS_FIELD_CLASS}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
      }}
      onBlur={() => {
        const values = text.split(',').map((value) => value.trim());
        props.onCommit(values);
        setText(values.join(', '));
      }}
    />
  );
}

function FormFields({ entry, onChange }: Omit<Props, 'idPrefix'>) {
  const attributes = entry.attributes ?? [];
  const text = (key: TextKey, label: string) => (
    <Row label={label}>
      <input
        aria-label={label}
        className={WSS_FIELD_CLASS}
        value={entry[key] ?? ''}
        onChange={(event) => {
          onChange({ ...entry, [key]: event.target.value });
        }}
      />
    </Row>
  );
  const setAttributes = (next: NonNullable<SamlEntry['attributes']>) => {
    onChange({ ...entry, attributes: next });
  };
  return (
    <>
      <Row label="SAML version">
        <select
          aria-label="SAML version"
          className={WSS_FIELD_CLASS}
          value={entry.version ?? '2.0'}
          onChange={(event) => {
            onChange({ ...entry, version: event.target.value as '1.1' | '2.0' });
          }}
        >
          <option value="2.0">2.0</option>
          <option value="1.1">1.1</option>
        </select>
      </Row>
      {text('issuer', 'Issuer')}
      {text('subject', 'Subject')}
      {text('subjectFormat', 'Subject format')}
      <Row label="Confirmation">
        <select
          aria-label="Confirmation"
          className={WSS_FIELD_CLASS}
          value={entry.confirmation ?? 'bearer'}
          onChange={(event) => {
            onChange({ ...entry, confirmation: event.target.value as 'bearer' | 'holder-of-key' | 'sender-vouches' });
          }}
        >
          <option value="bearer">Bearer</option>
          <option value="holder-of-key">Holder of key</option>
          <option value="sender-vouches">Sender vouches</option>
        </select>
      </Row>
      {entry.confirmation === 'holder-of-key' && (
        <KeystorePicker
          label="Proof keystore"
          keystoreRef={entry.proofKeystoreRef}
          alias={entry.proofAlias}
          onChange={(proofKeystoreRef, proofAlias) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit them
            const { proofKeystoreRef: droppedKeystore, proofAlias: droppedAlias, ...rest } = entry;
            onChange({
              ...rest,
              ...(proofKeystoreRef !== undefined ? { proofKeystoreRef } : {}),
              ...(proofAlias !== undefined ? { proofAlias } : {}),
            });
          }}
        />
      )}
      {text('audience', 'Audience')}
      <Row label="Lifetime (s)">
        <input
          aria-label="Lifetime"
          type="number"
          min={1}
          className={WSS_FIELD_CLASS}
          value={entry.lifetimeSeconds ?? 300}
          onChange={(event) => {
            onChange({ ...entry, lifetimeSeconds: Math.max(1, Number(event.target.value) || 1) });
          }}
        />
      </Row>
      {text('authnContext', 'Authentication context')}
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 text-xs text-fg-subtle">Attributes</span>
        <IconButton
          label="Add attribute"
          onClick={() => {
            setAttributes([...attributes, { name: '', values: [''] }]);
          }}
        >
          <Plus size={12} aria-hidden="true" />
        </IconButton>
      </div>
      <ul aria-label="Attributes" className="flex flex-col gap-1">
        {attributes.map((attribute, index) => (
          // Attributes have no ids; the whole list is replaced on each edit, so position is identity.
          <li key={index} className="flex items-center gap-1">
            <input
              aria-label={`Attribute ${String(index + 1)} name`}
              className={WSS_FIELD_CLASS}
              value={attribute.name}
              onChange={(event) => {
                setAttributes(
                  attributes.map((item, at) => (at === index ? { ...item, name: event.target.value } : item)),
                );
              }}
            />
            <AttributeValuesInput
              label={`Attribute ${String(index + 1)} values`}
              values={attribute.values}
              onCommit={(values) => {
                setAttributes(attributes.map((item, at) => (at === index ? { ...item, values } : item)));
              }}
            />
            <IconButton
              label={`Remove attribute ${String(index + 1)}`}
              onClick={() => {
                setAttributes(attributes.filter((_item, at) => at !== index));
              }}
            >
              <Trash2 size={12} aria-hidden="true" />
            </IconButton>
          </li>
        ))}
      </ul>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <input
          type="checkbox"
          aria-label="Sign as issuer"
          checked={entry.sign !== undefined}
          onChange={(event) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
            const { sign: dropped, ...rest } = entry;
            onChange(
              event.target.checked ? { ...rest, sign: { keystoreRef: '', signatureAlgorithm: 'rsa-sha256' } } : rest,
            );
          }}
        />
        Sign as issuer
      </label>
      {entry.sign !== undefined && <SigningFields entry={entry} sign={entry.sign} onChange={onChange} />}
    </>
  );
}

function XmlFields({ entry, onChange }: Omit<Props, 'idPrefix'>) {
  const fromFile = entry.file !== undefined;
  return (
    <>
      <Row label="Source">
        <select
          aria-label="XML source"
          className={WSS_FIELD_CLASS}
          value={fromFile ? 'file' : 'inline'}
          onChange={(event) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit them
            const { xml: droppedXml, file: droppedFile, ...rest } = entry;
            onChange(event.target.value === 'file' ? { ...rest, file: '' } : { ...rest, xml: '' });
          }}
        >
          <option value="inline">Inline</option>
          <option value="file">Project file</option>
        </select>
      </Row>
      {fromFile ? (
        <Row label="File">
          <input
            aria-label="Assertion file"
            placeholder="tokens/assertion.xml"
            className={WSS_FIELD_CLASS}
            value={entry.file ?? ''}
            onChange={(event) => {
              onChange({ ...entry, file: event.target.value });
            }}
          />
        </Row>
      ) : (
        <textarea
          aria-label="Assertion XML"
          spellCheck={false}
          rows={6}
          className={`${WSS_FIELD_CLASS} font-mono`}
          value={entry.xml ?? ''}
          onChange={(event) => {
            onChange({ ...entry, xml: event.target.value });
          }}
        />
      )}
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <input
          type="checkbox"
          checked={entry.expandProperties === true}
          onChange={(event) => {
            onChange({ ...entry, expandProperties: event.target.checked });
          }}
        />
        Expand properties
      </label>
      {entry.expandProperties === true && (
        <p className="text-xs text-fg-subtle">Expanding properties breaks a signed assertion.</p>
      )}
    </>
  );
}

/** The SAML token entry: a Form/XML switch over the two field sets. */
export function SamlTokenFields({ entry, onChange, idPrefix }: Props) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      <div role="radiogroup" aria-label="SAML token source" className="flex gap-2 text-xs text-fg-subtle">
        {(['form', 'xml'] as const).map((source) => (
          <label key={source} className="flex items-center gap-1">
            <input
              type="radio"
              name={`${idPrefix}-saml-source`}
              aria-label={source === 'form' ? 'Form' : 'XML'}
              checked={entry.source === source}
              onChange={() => {
                if (entry.source !== source) onChange(source === 'form' ? newSamlFormEntry() : newSamlXmlEntry());
              }}
            />
            {source === 'form' ? 'Form' : 'XML'}
          </label>
        ))}
      </div>
      {entry.source === 'form' ? (
        <FormFields entry={entry} onChange={onChange} />
      ) : (
        <XmlFields entry={entry} onChange={onChange} />
      )}
    </div>
  );
}
