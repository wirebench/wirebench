/**
 * The WS-Addressing editor, shared by the request pane's WS-A inspector and the interface
 * Details panel — the two levels hold the same configuration, and editing them through one
 * component is what keeps "override the interface field by field" honest.
 *
 * Nothing here can carry a secret: a `wsa:*` header is addressing metadata.
 */

import type { WsaConfigWire } from '../../shared/wire-types.js';

const INPUT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-xs text-fg-default focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50';

/** The free-text fields, in the order they appear in a header block. */
const TEXT_FIELDS = [
  ['action', 'Action'],
  ['to', 'To'],
  ['replyTo', 'ReplyTo'],
  ['from', 'From'],
  ['faultTo', 'FaultTo'],
  ['relatesTo', 'RelatesTo'],
  ['relationshipType', 'RelationshipType'],
] as const;

/** The "add the default" switches, which decide what an empty field falls back to. */
const FLAGS = [
  ['addDefaultAction', 'Add default wsa:Action'],
  ['addDefaultTo', 'Add default wsa:To'],
  ['generateMessageId', 'Generate MessageID'],
] as const;

export interface WsaFieldsProps {
  /** The configuration being edited; the effective one when `readOnly`. */
  readonly config: WsaConfigWire;
  /** Prefixes every `data-testid`, so the request and interface editors stay distinguishable. */
  readonly testIdPrefix: string;
  /** Greys the whole form out — what the request inspector shows while inheriting. */
  readonly readOnly?: boolean;
  readonly onChange: (patch: Partial<WsaConfigWire>) => void;
}

/** The editable WS-Addressing form for one level (interface defaults or request overrides). */
export function WsaFields({ config, testIdPrefix, readOnly = false, onChange }: WsaFieldsProps) {
  const messageIdAuto = (config.messageId ?? 'auto') === 'auto';
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-fg-default">
        <input
          type="checkbox"
          data-testid={`${testIdPrefix}-enabled`}
          checked={config.enabled}
          disabled={readOnly}
          onChange={(event) => {
            onChange({ enabled: event.target.checked });
          }}
        />
        <span className="text-xs">Enable WS-A addressing</span>
      </label>

      <label className="flex items-center gap-2">
        <span className="w-32 shrink-0 text-xs text-fg-subtle">Version</span>
        <select
          aria-label="WS-A version"
          data-testid={`${testIdPrefix}-version`}
          className={INPUT_CLASS}
          value={config.version ?? '2005/08'}
          disabled={readOnly}
          onChange={(event) => {
            onChange({ version: event.target.value as WsaConfigWire['version'] });
          }}
        >
          <option value="2005/08">2005/08 (W3C)</option>
          <option value="2004/08">2004/08 (Submission)</option>
        </select>
      </label>

      <label className="flex items-center gap-2">
        <span className="w-32 shrink-0 text-xs text-fg-subtle">mustUnderstand</span>
        <select
          aria-label="WS-A mustUnderstand"
          data-testid={`${testIdPrefix}-must-understand`}
          className={INPUT_CLASS}
          value={config.mustUnderstand ?? 'none'}
          disabled={readOnly}
          onChange={(event) => {
            onChange({ mustUnderstand: event.target.value as WsaConfigWire['mustUnderstand'] });
          }}
        >
          <option value="none">not set</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </label>

      {TEXT_FIELDS.map(([field, label]) => (
        <label key={field} className="flex items-center gap-2">
          <span className="w-32 shrink-0 text-xs text-fg-subtle">{label}</span>
          <input
            aria-label={`WS-A ${label}`}
            data-testid={`${testIdPrefix}-${field}`}
            className={INPUT_CLASS}
            value={config[field] ?? ''}
            disabled={readOnly}
            onChange={(event) => {
              onChange({ [field]: event.target.value });
            }}
          />
        </label>
      ))}

      <label className="flex items-center gap-2">
        <span className="w-32 shrink-0 text-xs text-fg-subtle">MessageID</span>
        <input
          aria-label="WS-A MessageID"
          data-testid={`${testIdPrefix}-message-id`}
          className={INPUT_CLASS}
          value={messageIdAuto ? '' : (config.messageId ?? '')}
          placeholder={messageIdAuto ? 'urn:uuid:… (generated per send)' : ''}
          disabled={readOnly || messageIdAuto}
          onChange={(event) => {
            onChange({ messageId: event.target.value });
          }}
        />
      </label>
      <label className="flex items-center gap-2 pl-32 text-fg-default">
        <input
          type="checkbox"
          data-testid={`${testIdPrefix}-message-id-auto`}
          checked={messageIdAuto}
          disabled={readOnly}
          onChange={(event) => {
            // Leaving `auto` keeps the field empty rather than inventing a value the user would
            // then have to clear; a fixed id is something they type on purpose.
            onChange({ messageId: event.target.checked ? 'auto' : '' });
          }}
        />
        <span className="text-xs">Auto (a fresh urn:uuid per send)</span>
      </label>

      {FLAGS.map(([field, label]) => (
        <label key={field} className="flex items-center gap-2 text-fg-default">
          <input
            type="checkbox"
            data-testid={`${testIdPrefix}-${field}`}
            checked={config[field] ?? true}
            disabled={readOnly}
            onChange={(event) => {
              onChange({ [field]: event.target.checked });
            }}
          />
          <span className="text-xs">{label}</span>
        </label>
      ))}
    </div>
  );
}
