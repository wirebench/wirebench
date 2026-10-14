/**
 * The operation's answer, drawn by what it is (#79).
 *
 * A `tools/call` result is its content blocks, by type: text as text (with a pretty-JSON toggle when
 * it parses), an image from its base64 as a `data:` URL (the renderer's CSP allows `img-src data:`),
 * audio as a labelled block with its type and size and no player, and resource links and embedded
 * resources as their URI, MIME type and text or blob size. `structuredContent` follows as pretty
 * JSON. A `resources/read` result is its contents as embedded resources; a `prompts/get` result is
 * its messages, each a role and a block. The four list methods are tables of what the server has.
 * Anything this does not recognise is shown as JSON rather than dropped.
 *
 * Every block reads its fields defensively: the result is the server's, as it came, and a server
 * that sends a block without its `text` must not blank the pane.
 */
import { useMemo, useState } from 'react';
import { base64ByteLength, formatBytes } from '../../../lib/format-size.js';

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** `value` as pretty JSON. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

/** The parsed JSON a text holds when it is an object or an array; `undefined` for anything else. */
export function jsonOf(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** A base64 payload as a `data:` URL, or `undefined` when either half would make a bad one. */
export function imageDataUrl(mimeType: string | undefined, data: string | undefined): string | undefined {
  if (mimeType === undefined || data === undefined) return undefined;
  if (!/^image\/[\w.+-]+$/i.test(mimeType)) return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data.replace(/\s/g, ''))) return undefined;
  return `data:${mimeType};base64,${data.replace(/\s/g, '')}`;
}

function JsonBlock({ value, testid }: { readonly value: unknown; readonly testid?: string }) {
  return (
    <pre
      data-testid={testid}
      className="overflow-auto rounded-sm bg-surface-sunken p-2 font-mono text-xs whitespace-pre-wrap text-fg-default select-text"
    >
      {prettyJson(value)}
    </pre>
  );
}

function BlockFrame({
  label,
  type,
  children,
}: {
  readonly label: string;
  readonly type: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section data-testid={`mcp-block-${type}`} className="flex flex-col gap-1 border-b border-hairline px-2 py-2">
      <h4 className="text-xs tracking-wider text-fg-subtle uppercase">{label}</h4>
      {children}
    </section>
  );
}

/** A text block: the text, and a pretty-JSON view when it is JSON. */
function TextBlock({ text }: { readonly text: string }) {
  const parsed = useMemo(() => jsonOf(text), [text]);
  const [pretty, setPretty] = useState(true);
  const isJson = parsed !== undefined;
  return (
    <BlockFrame label="Text" type="text">
      {isJson && (
        <label className="flex items-center gap-1 text-xs text-fg-muted">
          <input
            type="checkbox"
            data-testid="mcp-text-pretty"
            checked={pretty}
            onChange={(event) => {
              setPretty(event.target.checked);
            }}
          />
          Pretty JSON
        </label>
      )}
      <pre
        data-testid="mcp-text-body"
        className="overflow-auto font-mono text-xs whitespace-pre-wrap text-fg-default select-text"
      >
        {isJson && pretty ? prettyJson(parsed) : text}
      </pre>
    </BlockFrame>
  );
}

function Field({ name, value }: { readonly name: string; readonly value: string | undefined }) {
  if (value === undefined) return null;
  return (
    <>
      <dt className="text-fg-subtle">{name}</dt>
      <dd className="font-mono break-all text-fg-default">{value}</dd>
    </>
  );
}

/** A resource's own fields: what an embedded resource and a `resources/read` content both are. */
function ResourceContents({ resource }: { readonly resource: Json }) {
  const text = str(resource.text);
  const blob = str(resource.blob);
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <Field name="URI" value={str(resource.uri)} />
        <Field name="MIME type" value={str(resource.mimeType)} />
        {blob !== undefined && <Field name="Blob" value={formatBytes(base64ByteLength(blob))} />}
      </dl>
      {text !== undefined && (
        <pre className="overflow-auto font-mono text-xs whitespace-pre-wrap text-fg-default select-text">{text}</pre>
      )}
    </>
  );
}

/** One content block, by its `type`. */
export function ContentBlock({ block }: { readonly block: unknown }) {
  if (!isObject(block)) return <JsonBlock value={block} />;
  const type = str(block.type);
  switch (type) {
    case 'text':
      return <TextBlock text={str(block.text) ?? ''} />;
    case 'image': {
      const mimeType = str(block.mimeType);
      const data = str(block.data);
      const src = imageDataUrl(mimeType, data);
      return (
        <BlockFrame label={`Image · ${mimeType ?? 'unknown type'}`} type="image">
          {src === undefined ? (
            <p className="text-xs text-status-warning">This image’s type or data cannot be shown.</p>
          ) : (
            <img src={src} alt={`Image result (${mimeType ?? ''})`} className="max-h-96 max-w-full self-start" />
          )}
          {data !== undefined && <p className="text-xs text-fg-subtle">{formatBytes(base64ByteLength(data))}</p>}
        </BlockFrame>
      );
    }
    case 'audio': {
      const data = str(block.data);
      return (
        <BlockFrame label="Audio" type="audio">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <Field name="MIME type" value={str(block.mimeType) ?? 'unknown'} />
            <Field name="Size" value={data === undefined ? undefined : formatBytes(base64ByteLength(data))} />
          </dl>
        </BlockFrame>
      );
    }
    case 'resource_link':
      return (
        <BlockFrame label="Resource link" type="resource_link">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <Field name="Name" value={str(block.name)} />
            <Field name="URI" value={str(block.uri)} />
            <Field name="MIME type" value={str(block.mimeType)} />
            <Field name="Description" value={str(block.description)} />
          </dl>
        </BlockFrame>
      );
    case 'resource':
      return (
        <BlockFrame label="Embedded resource" type="resource">
          {isObject(block.resource) ? <ResourceContents resource={block.resource} /> : <JsonBlock value={block} />}
        </BlockFrame>
      );
    default:
      return (
        <BlockFrame label={type === undefined ? 'Block' : `Block · ${type}`} type="unknown">
          <JsonBlock value={block} />
        </BlockFrame>
      );
  }
}

/** The columns a list method's table shows, and the result field the list sits in. */
const LIST_TABLES: Readonly<
  Record<string, { readonly field: string; readonly columns: readonly (readonly [string, string])[] }>
> = {
  'tools/list': {
    field: 'tools',
    columns: [
      ['name', 'Name'],
      ['description', 'Description'],
    ],
  },
  'resources/list': {
    field: 'resources',
    columns: [
      ['name', 'Name'],
      ['uri', 'URI'],
      ['mimeType', 'MIME type'],
      ['description', 'Description'],
    ],
  },
  'resources/templates/list': {
    field: 'resourceTemplates',
    columns: [
      ['name', 'Name'],
      ['uriTemplate', 'URI template'],
      ['description', 'Description'],
    ],
  },
  'prompts/list': {
    field: 'prompts',
    columns: [
      ['name', 'Name'],
      ['description', 'Description'],
    ],
  },
};

function ListTable({ method, items }: { readonly method: string; readonly items: readonly unknown[] }) {
  const columns = LIST_TABLES[method]?.columns ?? [];
  if (items.length === 0) return <p className="p-2 text-sm text-fg-subtle">The server listed none.</p>;
  return (
    <table aria-label={`${method} result`} data-testid="mcp-result-table" className="w-full border-collapse text-xs">
      <thead>
        <tr className="border-b border-hairline text-left text-fg-subtle">
          {columns.map(([key, label]) => (
            <th key={key} scope="col" className="px-2 py-1 font-medium">
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((item, index) => (
          <tr key={index} className="border-b border-hairline align-top">
            {columns.map(([key]) => (
              <td key={key} className={`px-2 py-1 break-words ${key === 'name' ? 'font-mono' : ''} text-fg-default`}>
                {isObject(item) ? (str(item[key]) ?? '') : ''}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface McpResultViewProps {
  /** The operation's JSON-RPC method. */
  readonly method: string;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown } | undefined;
  /** History kept no result because it was too large. */
  readonly resultOmitted?: boolean | undefined;
}

/** The result, or the JSON-RPC error, of one operation. */
export function McpResultView({ method, result, error, resultOmitted }: McpResultViewProps) {
  if (error !== undefined) {
    return (
      <div data-testid="mcp-result-error" className="flex flex-col gap-1 p-2 text-sm">
        <p className="font-mono text-status-danger">{`Error ${String(error.code)} ${error.message}`}</p>
        {error.data !== undefined && <JsonBlock value={error.data} />}
      </div>
    );
  }
  if (result === undefined) {
    return (
      <p data-testid="mcp-result-none" className="p-3 text-sm text-fg-subtle">
        {resultOmitted === true ? 'Too large to keep here; its message may still hold it.' : 'No result.'}
      </p>
    );
  }
  return (
    <div data-testid="mcp-result" className="flex min-h-0 flex-1 flex-col overflow-auto">
      <ResultBody method={method} result={result} />
    </div>
  );
}

function ResultBody({ method, result }: { readonly method: string; readonly result: unknown }) {
  if (!isObject(result)) return <JsonBlock value={result} testid="mcp-result-json" />;

  const list = LIST_TABLES[method];
  if (list !== undefined && Array.isArray(result[list.field])) {
    const cursor = str(result.nextCursor);
    return (
      <>
        <ListTable method={method} items={result[list.field] as readonly unknown[]} />
        {cursor !== undefined && (
          <p className="px-2 py-1 text-xs text-fg-subtle">{`More follow: nextCursor ${cursor}`}</p>
        )}
      </>
    );
  }

  if (method === 'tools/call' && Array.isArray(result.content)) {
    return (
      <>
        {isToolErrorResult(result) && (
          <p className="px-2 py-1 text-xs text-status-warning">The tool reported an error (isError).</p>
        )}
        {(result.content as readonly unknown[]).map((block, index) => (
          <ContentBlock key={index} block={block} />
        ))}
        {result.structuredContent !== undefined && (
          <section className="flex flex-col gap-1 px-2 py-2">
            <h4 className="text-xs tracking-wider text-fg-subtle uppercase">Structured content</h4>
            <JsonBlock value={result.structuredContent} testid="mcp-structured-content" />
          </section>
        )}
      </>
    );
  }

  if (method === 'resources/read' && Array.isArray(result.contents)) {
    return (
      <>
        {(result.contents as readonly unknown[]).map((content, index) => (
          <BlockFrame key={index} label="Resource" type="resource">
            {isObject(content) ? <ResourceContents resource={content} /> : <JsonBlock value={content} />}
          </BlockFrame>
        ))}
      </>
    );
  }

  if (method === 'prompts/get' && Array.isArray(result.messages)) {
    const description = str(result.description);
    return (
      <>
        {description !== undefined && <p className="px-2 py-1 text-xs text-fg-muted">{description}</p>}
        {(result.messages as readonly unknown[]).map((message, index) => (
          <div key={index} data-testid="mcp-prompt-message" className="flex flex-col">
            <p className="px-2 pt-2 font-mono text-xs text-fg-subtle">
              {isObject(message) ? (str(message.role) ?? '?') : '?'}
            </p>
            <ContentBlock block={isObject(message) ? message.content : message} />
          </div>
        ))}
      </>
    );
  }

  return <JsonBlock value={result} testid="mcp-result-json" />;
}

const isToolErrorResult = (result: Json): boolean => result.isError === true;
