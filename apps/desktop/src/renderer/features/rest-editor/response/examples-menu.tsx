/**
 * The *Examples* menu on the REST response line (#64): the responses kept beside a request —
 * imported with it, or recorded — each one a click away from being shown in the pane.
 *
 * It is a plain disclosure list rather than a portalled menu, so it sits inside the pane it
 * belongs to; it closes on a choice, on Escape and on a press anywhere else.
 *
 * A shown example goes through the same Body and Headers views as a live response, under a banner
 * that says it is not one: an example is what came back once, and must never read as the answer
 * to the send the user just made.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { Tabs } from '../../../components/tabs.js';
import type { RestResponseExampleWire } from '../../../../shared/wire-types.js';
import { BodyView, type BodyViewExchange } from './body-view.js';
import { ResponseHeadersView } from './headers-view.js';
import { statusToneClass } from './status-line.js';

export interface ExamplesMenuProps {
  readonly examples: readonly RestResponseExampleWire[];
  /** Shows one in the pane, where its banner offers *Delete example*. */
  readonly onShow: (exampleId: string) => void;
}

/** The menu; nothing at all for a request without examples. */
export function ExamplesMenu({ examples, onShow }: ExamplesMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
    };
  }, [open]);

  if (examples.length === 0) {
    return null;
  }

  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <button
        type="button"
        data-testid="rest-examples-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((was) => !was);
        }}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-subtle hover:bg-surface-hover hover:text-fg-default"
      >
        Examples ({examples.length})
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <ul
          role="menu"
          aria-label="Response examples"
          className="absolute right-0 z-20 mt-1 max-h-72 min-w-56 overflow-auto rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
        >
          {examples.map((example) => (
            <li key={example.id} role="none">
              <button
                type="button"
                role="menuitem"
                data-testid={`rest-example-item-${example.id}`}
                onClick={() => {
                  setOpen(false);
                  onShow(example.id);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-fg-default hover:bg-accent-muted focus-visible:bg-accent-muted focus-visible:outline-none"
              >
                <span className={`font-mono text-xs ${statusToneClass(example.status)}`}>{example.status}</span>
                <span className="truncate">{example.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The body language an example's content type reads as, the way a live response's would. */
function exampleLanguage(contentType: string | undefined): BodyViewExchange['language'] {
  const type = (contentType ?? '').toLowerCase();
  if (/json/.test(type)) return 'json';
  if (/html/.test(type)) return 'html';
  if (/xml/.test(type)) return 'xml';
  if (/javascript/.test(type)) return 'javascript';
  return 'text';
}

/** UTF-8 bytes as base64, which the body views read for their byte counts and hex dump. */
function utf8Base64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const EXAMPLE_TABS = [
  { id: 'body', label: 'Body' },
  { id: 'headers', label: 'Headers' },
] as const;

export interface ExampleResponseProps {
  readonly example: RestResponseExampleWire;
  readonly onDelete: () => void;
  readonly onClose: () => void;
}

/** One example, read-only, in place of the live response. */
export function ExampleResponse({ example, onDelete, onClose }: ExampleResponseProps) {
  const [tab, setTab] = useState<(typeof EXAMPLE_TABS)[number]['id']>('body');
  const body = example.body ?? '';
  const exchange = useMemo<BodyViewExchange>(
    () => ({
      text: body,
      language: exampleLanguage(example.contentType),
      http: {
        bodyBase64: utf8Base64(body),
        headers: example.contentType !== undefined ? { 'content-type': example.contentType } : {},
      },
    }),
    [body, example.contentType],
  );
  const pairs = useMemo(() => example.headers.map((header) => [header.name, header.value] as const), [example.headers]);

  return (
    <>
      <div className="flex h-row shrink-0 items-center gap-2 border-b border-hairline bg-surface-raised px-2 text-xs">
        <span data-testid="rest-example-banner" className="font-medium text-status-info">
          Example — recorded, not a live response
        </span>
        <span className="min-w-0 flex-1 truncate text-fg-muted" title={example.name}>
          <span className={`font-mono ${statusToneClass(example.status)}`}>
            {example.status} {example.statusText}
          </span>
          {' · '}
          {example.name}
        </span>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button variant="ghost" data-testid="rest-example-delete" onClick={onDelete}>
          Delete example
        </Button>
      </div>
      <Tabs label="Example tabs" items={EXAMPLE_TABS} active={tab} onSelect={setTab} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === 'body' && <BodyView key={example.id} exchange={exchange} />}
        {tab === 'headers' && <ResponseHeadersView pairs={pairs} />}
      </div>
    </>
  );
}
