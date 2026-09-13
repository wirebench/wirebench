/**
 * The request body: a kind switch, and one editor per kind.
 *
 * Switching kinds keeps each kind's draft, so flipping to *None* to try a request without a body and
 * back does not cost the JSON that was typed. The drafts live in this component's own state, not in
 * the request: an unsent draft of a kind the request is not using has nothing to do with what is
 * saved on disk.
 *
 * A file is chosen through the same native picker attachments use. The renderer never names a path
 * of its own — the pick is what makes the file legal for main to read.
 */
import { useState } from 'react';
import { formatXml } from '@wirebench/engine/xml';
import { Button } from '../../components/button.js';
import { KvTable } from '../../components/kv-table.js';
import { showToast } from '../../components/toast.js';
import { CodeEditor } from '../../editor/code-editor.js';
import { ipc } from '../../state/ipc-client.js';
import { usePreferencesStore } from '../../state/preferences.js';
import type { KeyValueWire, RestBodyWire, RestRequestPatchWire, RestSettingsWire } from '../../../shared/wire-types.js';

/** The body kinds, in the order the switch offers them. */
const KINDS = [
  { id: 'none', label: 'None' },
  { id: 'raw', label: 'Raw' },
  { id: 'form', label: 'Form' },
  { id: 'multipart', label: 'Multipart' },
  { id: 'binary', label: 'Binary' },
] as const;

type BodyKind = RestBodyWire['kind'];

/** The raw-body languages the editor offers. */
const LANGUAGES = ['json', 'xml', 'text', 'html', 'javascript'] as const;

type RawLanguage = (typeof LANGUAGES)[number];

/** What a freshly switched-to kind starts as. */
function emptyBody(kind: BodyKind): RestBodyWire {
  switch (kind) {
    case 'none':
      return { kind: 'none' };
    case 'raw':
      return { kind: 'raw', language: 'json', text: '' };
    case 'form':
      return { kind: 'form', fields: [] };
    case 'multipart':
      return { kind: 'multipart', parts: [] };
    case 'binary':
      return { kind: 'binary', source: { kind: 'path', path: '' }, contentType: 'application/octet-stream' };
  }
}

/**
 * Pretty-prints a raw body, or reports why it could not be.
 *
 * JSON goes through `JSON.parse`, XML through the engine's own formatter — the same one the SOAP
 * editor's *Format* uses — and anything else is left alone, because there is no one right shape for
 * it. A body that does not parse is never silently rewritten.
 */
export function formatRawBody(
  text: string,
  language: RawLanguage,
  indent: number,
): { readonly text: string } | { readonly error: string } {
  if (language === 'json') {
    try {
      return { text: JSON.stringify(JSON.parse(text), null, indent) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'This is not valid JSON' };
    }
  }
  if (language === 'xml') {
    const result = formatXml(text, { indent: ' '.repeat(indent) });
    // A body that could not be reformatted safely (unbalanced tags) is reported, not rewritten.
    return result.problem === undefined ? { text: result.text } : { error: result.problem };
  }
  return { text };
}

export interface BodyTabProps {
  readonly body: RestBodyWire;
  readonly settings: RestSettingsWire;
  readonly onChange: (patch: RestRequestPatchWire) => void;
}

/** The Body tab. */
export function BodyTab({ body, settings, onChange }: BodyTabProps) {
  // One remembered draft per kind, seeded with the saved body's own kind.
  const [drafts, setDrafts] = useState<Partial<Record<BodyKind, RestBodyWire>>>({ [body.kind]: body });
  const indent = usePreferencesStore((state) => state.preferences.editor.tabSize);

  const set = (next: RestBodyWire): void => {
    setDrafts((current) => ({ ...current, [next.kind]: next }));
    onChange({ body: next });
  };

  const switchTo = (kind: BodyKind): void => {
    if (kind === body.kind) {
      return;
    }
    set(drafts[kind] ?? emptyBody(kind));
  };

  return (
    <div data-testid="rest-body" className="flex min-h-0 flex-col gap-2 p-3">
      <div className="flex shrink-0 items-center gap-2">
        <select
          aria-label="Body kind"
          data-testid="rest-body-kind"
          value={body.kind}
          className="h-row rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
          onChange={(event) => {
            switchTo(event.target.value as BodyKind);
          }}
        >
          {KINDS.map((kind) => (
            <option key={kind.id} value={kind.id}>
              {kind.label}
            </option>
          ))}
        </select>

        {body.kind === 'raw' && (
          <>
            <select
              aria-label="Body language"
              data-testid="rest-body-language"
              value={body.language}
              className="h-row rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
              onChange={(event) => {
                set({ ...body, language: event.target.value as RawLanguage });
              }}
            >
              {LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {language}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              data-testid="rest-body-format"
              onClick={() => {
                const result = formatRawBody(body.text, body.language, indent);
                if ('error' in result) {
                  showToast(`Could not format the body: ${result.error}`);
                  return;
                }
                set({ ...body, text: result.text });
              }}
            >
              Format
            </Button>
            <label className="flex items-center gap-1.5 text-xs text-fg-muted">
              <input
                type="checkbox"
                data-testid="rest-body-escape"
                checked={settings.escapeProperties ?? false}
                onChange={(event) => {
                  onChange({ settings: { ...settings, escapeProperties: event.target.checked } });
                }}
              />
              Escape substituted values
            </label>
          </>
        )}
      </div>

      {body.kind === 'none' && <p className="text-sm text-fg-subtle">This request sends no body.</p>}

      {body.kind === 'raw' && (
        <div data-testid="rest-body-editor" className="min-h-0 flex-1">
          <CodeEditor
            value={body.text}
            language={body.language}
            ariaLabel="Request body"
            onChange={(text) => {
              set({ ...body, text });
            }}
          />
        </div>
      )}

      {body.kind === 'form' && (
        <KvTable
          label="Form fields"
          testidPrefix="rest-form"
          rows={body.fields}
          columns={['enabled', 'name', 'value', 'description']}
          // A form field is a name the server reads once, so a repeated one is a mistake here even
          // though the encoding would carry it.
          allowDuplicates={false}
          emptyMessage="No fields yet."
          onChange={(fields) => {
            set({ kind: 'form', fields: [...fields] });
          }}
        />
      )}

      {body.kind === 'multipart' && <MultipartParts body={body} onSet={set} />}

      {body.kind === 'binary' && <BinaryBody body={body} onSet={set} />}
    </div>
  );
}

/** Shows the native picker and returns the first path chosen, if any. */
async function pickFile(): Promise<string | undefined> {
  const picked = await ipc().attachments.pickFiles({});
  if (!picked.ok) {
    showToast(picked.error.message);
    return undefined;
  }
  return picked.value.paths[0];
}

type MultipartBody = Extract<RestBodyWire, { kind: 'multipart' }>;

/** The multipart parts: text parts in a table, file parts as rows with a picker. */
function MultipartParts({
  body,
  onSet,
}: {
  readonly body: MultipartBody;
  readonly onSet: (body: RestBodyWire) => void;
}) {
  const textParts = body.parts.filter((part) => part.kind === 'text');
  const fileParts = body.parts.filter((part) => part.kind === 'file');

  /** Replaces every text part, keeping the file parts and their order after them. */
  const setTextParts = (rows: readonly KeyValueWire[]): void => {
    onSet({
      kind: 'multipart',
      parts: [
        ...rows.map((row) => ({ kind: 'text' as const, name: row.name, value: row.value, enabled: row.enabled })),
        ...fileParts,
      ],
    });
  };

  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-auto">
      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">Text parts</h3>
        <KvTable
          label="Multipart text parts"
          testidPrefix="rest-multipart"
          rows={textParts.map((part) => ({ name: part.name, value: part.value, enabled: part.enabled }))}
          emptyMessage="No text parts yet."
          onChange={setTextParts}
        />
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">File parts</h3>
        <ul data-testid="rest-multipart-files" className="flex flex-col gap-1">
          {fileParts.map((part, index) => (
            <li key={index} className="flex items-center gap-2 text-sm">
              <span className="w-32 shrink-0 truncate font-mono text-fg-default">{part.name || '(unnamed)'}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-subtle">
                {part.source.kind === 'path' ? part.source.path : `cached ${part.source.sha256.slice(0, 12)}`}
              </span>
              <Button
                variant="secondary"
                data-testid="rest-multipart-remove-file"
                onClick={() => {
                  onSet({ kind: 'multipart', parts: body.parts.filter((candidate) => candidate !== part) });
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <div>
          <Button
            variant="secondary"
            data-testid="rest-multipart-add-file"
            onClick={() => {
              void pickFile().then((path) => {
                if (path === undefined) {
                  return;
                }
                onSet({
                  kind: 'multipart',
                  parts: [...body.parts, { kind: 'file', name: 'file', source: { kind: 'path', path }, enabled: true }],
                });
              });
            }}
          >
            Add file…
          </Button>
        </div>
      </section>
    </div>
  );
}

type BinaryBody = Extract<RestBodyWire, { kind: 'binary' }>;

/** The binary body: one file and its content type. */
function BinaryBody({ body, onSet }: { readonly body: BinaryBody; readonly onSet: (body: RestBodyWire) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">
        <span data-testid="rest-binary-path" className="min-w-0 flex-1 truncate font-mono text-xs text-fg-subtle">
          {body.source.kind === 'path'
            ? body.source.path === ''
              ? 'No file chosen.'
              : body.source.path
            : `cached ${body.source.sha256.slice(0, 12)}`}
        </span>
        <Button
          variant="secondary"
          data-testid="rest-binary-choose"
          onClick={() => {
            void pickFile().then((path) => {
              if (path !== undefined) {
                onSet({ ...body, source: { kind: 'path', path } });
              }
            });
          }}
        >
          Choose file…
        </Button>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <span className="w-28 shrink-0 text-xs text-fg-subtle">Content type</span>
        <input
          aria-label="Binary body content type"
          data-testid="rest-binary-content-type"
          value={body.contentType}
          className="h-row min-w-0 flex-1 rounded-md border border-hairline bg-surface-base px-2 font-mono text-sm text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
          onChange={(event) => {
            onSet({ ...body, contentType: event.target.value });
          }}
        />
      </label>
    </div>
  );
}
