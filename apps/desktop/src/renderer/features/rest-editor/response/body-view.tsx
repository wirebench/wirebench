/**
 * The response body: Pretty, Raw or Preview.
 *
 * **Pretty** is the body reformatted in the language it turned out to be, in a read-only Monaco with
 * folding and find. It is disabled above `preferences.rest.prettyPrintMaxBytes`, because formatting a
 * very large body means parsing it twice and re-laying it out — the kind of pause that reads as a
 * hang. **Raw** shows the bytes as they arrived, line by line and virtualised, so a huge body costs
 * only the lines on screen. **Preview** renders an image, and shows a hex dump for anything else
 * binary: a response that is not text still has to be inspectable.
 *
 * A JSON node's *Copy path* gives a JSONPath-style path, which is what the Query tab will take.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Copy } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { CodeEditor, type EditorLanguage } from '../../../editor/code-editor.js';
import { InspectorIconButton } from '../../request-editor/inspectors/inspector-strip.js';
import { formatBytes } from '../../../lib/format-size.js';
import { usePreferencesStore } from '../../../state/preferences.js';
import { formatRawBody } from '../body-tab.js';
import type { RestExchangeSummary } from '../../../../shared/wire-types.js';

/** Which of the three views is showing. */
export type BodyViewMode = 'pretty' | 'raw' | 'preview';

/** The languages `CodeEditor` can colour; anything else is shown as plain text. */
function editorLanguage(language: RestExchangeSummary['language']): EditorLanguage {
  switch (language) {
    case 'json':
    case 'xml':
    case 'html':
    case 'javascript':
      return language;
    default:
      return 'text';
  }
}

/** The languages `formatRawBody` can pretty-print; the rest are shown as they arrived. */
function formattable(language: RestExchangeSummary['language']): 'json' | 'xml' | undefined {
  return language === 'json' || language === 'xml' ? language : undefined;
}

/** Whether this response is an image the Preview tab can render. */
export function isImage(exchange: RestExchangeSummary): boolean {
  return exchange.language === 'image';
}

/** The bytes of a base64 body, decoded once. */
function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** How many bytes a hex dump shows per line. */
const HEX_COLUMNS = 16;
/** How many lines of a hex dump are built at all, so a huge body cannot freeze the pane. */
const HEX_MAX_LINES = 4096;

/** One line of a hex dump: offset, bytes, and the printable characters. */
export function hexLines(bytes: Uint8Array, limit = HEX_MAX_LINES): readonly string[] {
  const lines: string[] = [];
  for (let at = 0; at < bytes.length && lines.length < limit; at += HEX_COLUMNS) {
    const row = bytes.subarray(at, at + HEX_COLUMNS);
    const hex = [...row].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const text = [...row].map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.')).join('');
    lines.push(`${at.toString(16).padStart(8, '0')}  ${hex.padEnd(HEX_COLUMNS * 3 - 1, ' ')}  ${text}`);
  }
  return lines;
}

/** How tall one virtualised raw line is, in pixels. */
const RAW_LINE_HEIGHT = 18;

export interface BodyViewProps {
  readonly exchange: RestExchangeSummary;
  /** Called with a JSONPath-style path when the user copies one, so the Query tab can take it. */
  readonly onCopyPath?: (path: string) => void;
}

/** The body tab, with its own Pretty/Raw/Preview strip. */
export function BodyView({ exchange, onCopyPath }: BodyViewProps) {
  const maxPretty = usePreferencesStore((state) => state.preferences.rest.prettyPrintMaxBytes);
  const indent = usePreferencesStore((state) => state.preferences.editor.tabSize);
  const tooLargeToPretty = exchange.text.length > maxPretty;
  const image = isImage(exchange);
  const [mode, setMode] = useState<BodyViewMode>(image ? 'preview' : tooLargeToPretty ? 'raw' : 'pretty');

  const pretty = useMemo(() => {
    const language = formattable(exchange.language);
    if (language === undefined || tooLargeToPretty) {
      return exchange.text;
    }
    const result = formatRawBody(exchange.text, language, indent);
    // A body the server sent malformed is shown as it arrived: the point of the pane is to show
    // what came back, not to make it look valid.
    return 'text' in result ? result.text : exchange.text;
  }, [exchange.text, exchange.language, indent, tooLargeToPretty]);

  return (
    <div data-testid="rest-response-body" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-row shrink-0 items-center gap-1 px-2">
        {/* The three views are a tablist of their own: the copy actions beside them are buttons, and
            a `tablist` may only own tabs. */}
        <div role="tablist" aria-label="Response body view" className="flex items-center gap-1">
          {(['pretty', 'raw', 'preview'] as const).map((candidate) => {
            const disabled = candidate === 'pretty' && tooLargeToPretty;
            return (
              <button
                key={candidate}
                type="button"
                role="tab"
                data-testid={`rest-response-view-${candidate}`}
                aria-selected={mode === candidate}
                aria-disabled={disabled}
                disabled={disabled}
                {...(disabled
                  ? { title: `This body is larger than ${formatBytes(maxPretty)}, so it is not reformatted.` }
                  : {})}
                onClick={() => {
                  setMode(candidate);
                }}
                className={`rounded-sm px-2 text-xs capitalize ${
                  mode === candidate ? 'bg-surface-active text-fg-default' : 'text-fg-subtle'
                } ${disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-surface-hover'}`}
              >
                {candidate}
              </button>
            );
          })}
        </div>
        <span className="flex-1" />
        {exchange.language === 'json' && (
          <Button
            variant="secondary"
            data-testid="rest-response-copy-path"
            onClick={() => {
              // The root path: a deeper one needs a selection in the editor, which the Query tab
              // will drive. Copying `$` is the honest starting point for a query.
              void navigator.clipboard?.writeText('$');
              onCopyPath?.('$');
            }}
          >
            Copy path
          </Button>
        )}
        <InspectorIconButton
          label="Copy response body"
          onClick={() => {
            void navigator.clipboard?.writeText(exchange.text);
          }}
        >
          <Copy size={13} aria-hidden="true" />
        </InspectorIconButton>
      </div>

      <div data-testid={`rest-response-view-${mode}-panel`} className="min-h-0 flex-1">
        {mode === 'preview' ? (
          <PreviewView exchange={exchange} />
        ) : mode === 'raw' ? (
          <RawBody text={exchange.text} />
        ) : (
          <CodeEditor value={pretty} language={editorLanguage(exchange.language)} readOnly ariaLabel="Response body" />
        )}
      </div>

      {exchange.decodeNote !== undefined && (
        <p className="shrink-0 px-2 py-1 text-xs text-status-warning">{exchange.decodeNote}</p>
      )}
    </div>
  );
}

/** The raw body, line by line, virtualised so a large one costs only what is on screen. */
function RawBody({ text }: { readonly text: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => text.split('\n'), [text]);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => RAW_LINE_HEIGHT,
    overscan: 20,
  });

  if (text.length === 0) {
    return <p className="p-3 text-sm text-fg-subtle">This response had an empty body.</p>;
  }

  return (
    <div ref={scrollRef} data-testid="rest-response-raw" className="h-full overflow-auto px-2 font-mono text-xs">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-testid="rest-response-raw-line"
            style={{ position: 'absolute', top: item.start, height: item.size, left: 0, right: 0 }}
            className="truncate whitespace-pre text-fg-default"
          >
            {lines[item.index]}
          </div>
        ))}
      </div>
    </div>
  );
}

/** An image, or a hex dump of whatever else came back. */
function PreviewView({ exchange }: { readonly exchange: RestExchangeSummary }) {
  const [objectUrl, setObjectUrl] = useState<string | undefined>(undefined);
  const image = isImage(exchange);
  const contentType = exchange.http.headers['content-type'] ?? 'application/octet-stream';

  useEffect(() => {
    if (!image) {
      return;
    }
    // A blob URL rather than a `data:` one: the CSP allows `img-src 'self' data:` but a multi-megabyte
    // data URI would be built as a string first. The URL is revoked on unmount, so nothing leaks.
    const url = URL.createObjectURL(new Blob([bytesOf(exchange.http.bodyBase64)], { type: contentType }));
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setObjectUrl(undefined);
    };
  }, [image, exchange.http.bodyBase64, contentType]);

  if (image) {
    return (
      <div className="flex h-full items-start justify-center overflow-auto p-2">
        {objectUrl !== undefined && (
          <img data-testid="rest-response-image" src={objectUrl} alt="Response body" className="max-w-full" />
        )}
      </div>
    );
  }

  const bytes = bytesOf(exchange.http.bodyBase64);
  if (bytes.length === 0) {
    return <p className="p-3 text-sm text-fg-subtle">This response had an empty body.</p>;
  }

  return (
    <pre data-testid="rest-response-hex" className="h-full overflow-auto px-2 font-mono text-xs text-fg-default">
      {hexLines(bytes).join('\n')}
    </pre>
  );
}
