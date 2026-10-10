/**
 * The REST editor's top strip: Send (split, with its ▾ menu), the method and the URL. Send leads
 * the strip, as it does in every editor.
 *
 * Two things here are not ordinary form fields. The **method** is a select of the nine methods a
 * REST client sends plus a *Custom…* entry, because a REST client must be able to send a method this
 * build has never heard of. The **URL** is a {@link PropertyHighlightInput}: a relative URL shows
 * the API's effective base URL as a greyed prefix beside it — the user needs to see where the
 * request is actually going, and only main knows that.
 */
import { useState } from 'react';
import { Send, Square } from 'lucide-react';
import { Button, SPLIT_HEAD_CLASS } from '../../components/button.js';
import { PropertyHighlightInput } from './property-highlight-input.js';

/** The methods the select offers by name; anything else is typed through *Custom…*. */
export const KNOWN_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'] as const;

const CUSTOM = '__custom__';

const FIELD_FONT = 'font-mono text-sm leading-[26px]';

export interface UrlBarProps {
  readonly method: string;
  readonly url: string;
  /** The base URL a relative URL resolves against, as a greyed prefix. Absent while unknown. */
  readonly basePrefix?: string | undefined;
  /** Where that base came from — `api`, `environment`, `workspace` — shown on the prefix's title. */
  readonly baseSource?: string | undefined;
  /**
   * When set, the greyed prefix reads `<baseLabel> ·` instead of the base URL text — a webhook
   * item has no API, so there is no base worth showing in full — with the resolved base (when
   * known) carried in the prefix's `title` instead.
   */
  readonly baseLabel?: string | undefined;
  readonly sending: boolean;
  /** An event-stream response is arriving — Cancel reads *Stop* instead, same button, same handler. */
  readonly live?: boolean;
  readonly onMethodChange: (method: string) => void;
  readonly onUrlChange: (url: string) => void;
  readonly onSend: () => void;
  readonly onCancel: () => void;
  /** The formatted `Mod+Enter` shortcut, shown on Send's title. */
  readonly sendShortcut?: string | undefined;
  /** Disables *Send* when set, e.g. a webhook item with no target — the reason is the button's title. */
  readonly sendDisabledReason?: string | undefined;
  /** The ▾ joined to Send's right; passed in so this strip needs nothing from the stores. */
  readonly menu?: React.ReactNode;
}

/** The Send, method and URL strip. */
export function UrlBar({
  method,
  url,
  basePrefix,
  baseSource,
  baseLabel,
  sending,
  live = false,
  onMethodChange,
  onUrlChange,
  onSend,
  onCancel,
  sendShortcut,
  sendDisabledReason,
  menu,
}: UrlBarProps) {
  const known = (KNOWN_METHODS as readonly string[]).includes(method.toUpperCase());
  const [custom, setCustom] = useState(!known);

  return (
    <div className="flex h-title-bar shrink-0 items-center gap-2 border-b border-hairline bg-surface-base px-3">
      {sending ? (
        <Button
          variant="secondary"
          data-testid="rest-send"
          onClick={onCancel}
          title={live ? 'Stop the stream (Esc)' : 'Cancel (Esc)'}
        >
          <Square size={12} aria-hidden="true" />
          {live ? 'Stop' : 'Cancel'}
        </Button>
      ) : (
        <div className="flex shrink-0 items-center">
          <Button
            variant="primary"
            data-testid="rest-send"
            className={menu === undefined ? '' : SPLIT_HEAD_CLASS}
            onClick={onSend}
            disabled={sendDisabledReason !== undefined}
            {...(sendDisabledReason !== undefined
              ? { title: sendDisabledReason }
              : sendShortcut !== undefined
                ? { title: `Send (${sendShortcut})` }
                : {})}
          >
            <Send size={12} aria-hidden="true" />
            Send
          </Button>
          {menu}
        </div>
      )}

      {custom ? (
        <input
          aria-label="Request method"
          data-testid="rest-method"
          value={method}
          size={8}
          className="h-row w-20 shrink-0 rounded-md border border-hairline-strong bg-surface-raised px-2 font-mono text-sm text-fg-default uppercase focus:ring-1 focus:ring-accent focus:outline-none"
          onChange={(event) => {
            onMethodChange(event.target.value.toUpperCase());
          }}
        />
      ) : (
        <select
          aria-label="Request method"
          data-testid="rest-method"
          value={method.toUpperCase()}
          className="h-row w-24 shrink-0 rounded-md border border-hairline-strong bg-surface-raised px-2 font-mono text-sm text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
          onChange={(event) => {
            if (event.target.value === CUSTOM) {
              setCustom(true);
              return;
            }
            onMethodChange(event.target.value);
          }}
        >
          {KNOWN_METHODS.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate}
            </option>
          ))}
          <option value={CUSTOM}>Custom…</option>
        </select>
      )}

      <div className="flex h-row min-w-0 flex-1 items-center overflow-hidden rounded-md border border-hairline-strong bg-surface-raised">
        {(baseLabel !== undefined || (basePrefix !== undefined && basePrefix.length > 0)) && (
          <span
            data-testid="rest-url-base"
            title={
              baseLabel !== undefined
                ? (basePrefix ?? baseLabel)
                : baseSource === undefined
                  ? basePrefix
                  : `${basePrefix} — from the ${baseSource}`
            }
            className={`max-w-[45%] shrink-0 truncate pl-2 text-fg-subtle ${FIELD_FONT}`}
          >
            {baseLabel !== undefined ? `${baseLabel} ·` : basePrefix}
          </span>
        )}
        <PropertyHighlightInput
          ariaLabel="Request URL"
          testId="rest-url"
          value={url}
          placeholder="/path or https://host/path"
          onChange={onUrlChange}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              // Enter is the Send button's keyboard twin, so it is disabled with it.
              if (sendDisabledReason === undefined) {
                onSend();
              }
            }
          }}
        />
      </div>
    </div>
  );
}
