/**
 * The REST editor's top strip: the method, the URL, Send, and the overflow menu.
 *
 * Two things here are not ordinary form fields. The **method** is a select of the nine methods a
 * REST client sends plus a *Custom…* entry, because a REST client must be able to send a method this
 * build has never heard of. The **URL** is an input with a highlighted mirror behind it: property
 * references (`${…}`) and path placeholders (`{param}`) are coloured so an unfilled one is visible
 * while typing, and a relative URL shows the API's effective base URL as a greyed prefix — the user
 * needs to see where the request is actually going, and only main knows that.
 *
 * The mirror is a plain element rather than a Monaco instance: a single-line field does not need an
 * editor (no folding, no find, no completion), and one Monaco per open tab for a URL would be paid
 * for on every tab switch.
 */
import { useRef, useState } from 'react';
import { Send, Square } from 'lucide-react';
import { Button } from '../../components/button.js';
import { urlSegments } from '../../state/rest-url.js';

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
  readonly sending: boolean;
  readonly onMethodChange: (method: string) => void;
  readonly onUrlChange: (url: string) => void;
  readonly onSend: () => void;
  readonly onCancel: () => void;
  /** The formatted `Mod+Enter` shortcut, shown on Send's title. */
  readonly sendShortcut?: string | undefined;
  /** The overflow menu; passed in so this strip needs nothing from the stores. */
  readonly menu?: React.ReactNode;
}

/** The method, URL and Send strip. */
export function UrlBar({
  method,
  url,
  basePrefix,
  baseSource,
  sending,
  onMethodChange,
  onUrlChange,
  onSend,
  onCancel,
  sendShortcut,
  menu,
}: UrlBarProps) {
  const known = (KNOWN_METHODS as readonly string[]).includes(method.toUpperCase());
  const [custom, setCustom] = useState(!known);
  const mirrorRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex h-title-bar shrink-0 items-center gap-2 border-b border-hairline bg-surface-base px-3">
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
        {basePrefix !== undefined && basePrefix.length > 0 && (
          <span
            data-testid="rest-url-base"
            title={baseSource === undefined ? basePrefix : `${basePrefix} — from the ${baseSource}`}
            className={`max-w-[45%] shrink-0 truncate pl-2 text-fg-subtle ${FIELD_FONT}`}
          >
            {basePrefix}
          </span>
        )}
        {/* The mirror and the input share the same font, padding and box, and the input's own text
            is transparent, so the coloured runs behind it line up with the caret exactly. */}
        <div className="relative min-w-0 flex-1">
          <div
            ref={mirrorRef}
            aria-hidden="true"
            data-testid="rest-url-highlight"
            className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre px-2 ${FIELD_FONT}`}
          >
            {urlSegments(url).map((segment, index) => (
              <span
                key={index}
                data-kind={segment.kind}
                className={
                  segment.kind === 'property'
                    ? 'text-accent'
                    : segment.kind === 'param'
                      ? 'text-status-info'
                      : 'text-fg-default'
                }
              >
                {segment.text}
              </span>
            ))}
          </div>
          <input
            aria-label="Request URL"
            data-testid="rest-url"
            spellCheck={false}
            value={url}
            placeholder="/path or https://host/path"
            className={`relative h-row w-full bg-transparent px-2 text-transparent caret-fg-default placeholder:text-fg-faint focus:outline-none ${FIELD_FONT}`}
            onChange={(event) => {
              onUrlChange(event.target.value);
            }}
            onScroll={(event) => {
              // Keep the mirror in step when the text is longer than the field.
              if (mirrorRef.current !== null) {
                mirrorRef.current.scrollLeft = event.currentTarget.scrollLeft;
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                onSend();
              }
            }}
          />
        </div>
      </div>

      {sending ? (
        <Button variant="secondary" data-testid="rest-send" onClick={onCancel} title="Cancel (Esc)">
          <Square size={12} aria-hidden="true" />
          Cancel
        </Button>
      ) : (
        <Button
          variant="primary"
          data-testid="rest-send"
          onClick={onSend}
          {...(sendShortcut !== undefined ? { title: `Send (${sendShortcut})` } : {})}
        >
          <Send size={12} aria-hidden="true" />
          Send
        </Button>
      )}
      {menu}
    </div>
  );
}
