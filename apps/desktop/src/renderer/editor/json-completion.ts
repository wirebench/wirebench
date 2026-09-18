/**
 * Field-name completion in a JSON editor, driven by whatever schema the editor was opened against.
 *
 * Monaco registers a completion provider per *language*, and this build has one JSON language that
 * every raw body in the app is edited in — a REST request body, a gRPC message, a response shown
 * read-only. Only some of those have a schema, so the provider is registered once for the language
 * and consults a registry keyed by model URI: an editor that has registered a source gets
 * completions, and every other JSON editor is left exactly as it was.
 *
 * The cursor analysis is the engine's pure `jsonCompletionContextAt`; what the fields *are* comes
 * from main, which holds the parsed schema. Nothing here parses JSON or protobuf.
 */
import { jsonCompletionContextAt } from '@wirebench/engine/json';
import type { JsonCompletionContext } from '@wirebench/engine/json';
import type * as Monaco from 'monaco-editor';
import type { GrpcMessageFieldWire } from '../../shared/wire-types.js';
import { JSON_LANGUAGE_ID } from './json-language.js';

/** What an editor registers to get its fields completed: the schema lookup for one document. */
export interface JsonCompletionSource {
  /** The fields of the object at `path`, or none when the path names nothing in the schema. */
  fetchFields(path: readonly string[]): Promise<readonly GrpcMessageFieldWire[]>;
}

const sources = new Map<string, JsonCompletionSource>();

/** Points the provider at a schema for the model at `modelUri`. */
export function setJsonCompletionSource(modelUri: string, source: JsonCompletionSource): void {
  sources.set(modelUri, source);
}

/** Forgets the schema for `modelUri`, leaving that editor with no completions again. */
export function clearJsonCompletionSource(modelUri: string): void {
  sources.delete(modelUri);
}

/** The scalar types protobuf's JSON mapping writes as strings rather than numbers. */
const STRING_SCALARS: ReadonlySet<string> = new Set([
  'string',
  'bytes',
  'int64',
  'uint64',
  'sint64',
  'fixed64',
  'sfixed64',
]);

/** A Monaco-shaped completion item for one field, ready to be given a range. */
export interface FieldCompletionItem {
  readonly label: string;
  readonly insertText: string;
  /** The type, as the suggestion list's right-hand column. */
  readonly detail: string;
  readonly documentation?: string;
  /** Keeps the list in declaration order rather than Monaco's alphabetical default. */
  readonly sortText: string;
}

/** The snippet written after the colon: an empty value of the field's JSON shape, cursor inside it. */
function valueSnippet(field: GrpcMessageFieldWire): string {
  if (field.repeated) {
    return '[$0]';
  }
  if (field.valueKind === 'message' || field.valueKind === 'map') {
    return '{$0}';
  }
  if (field.valueKind === 'enum' || STRING_SCALARS.has(field.type)) {
    return '"$0"';
  }
  return '$0';
}

/** The right-hand column: the type as declared, with the shape the JSON takes it in. */
function detailOf(field: GrpcMessageFieldWire): string {
  const type = field.valueKind === 'map' ? `map<${field.type}>` : field.type;
  return field.repeated ? `repeated ${type}` : type;
}

function documentationOf(field: GrpcMessageFieldWire): string | undefined {
  const lines: string[] = [];
  if (field.comment !== undefined) {
    lines.push(field.comment);
  }
  if (field.oneof !== undefined) {
    lines.push(`One of \`${field.oneof}\`.`);
  }
  if (field.enumValues !== undefined && field.enumValues.length > 0) {
    lines.push(field.enumValues.map((value) => `\`${value}\``).join(' · '));
  }
  return lines.length > 0 ? lines.join('\n\n') : undefined;
}

/**
 * The items to offer for `fields` at `context`, in declaration order.
 *
 * Two things are left out. A key the object already holds, because JSON will not let it repeat;
 * and the rest of a `oneof` whose member is already written, because protobuf will not let *those*
 * repeat either — setting a second member silently clears the first.
 */
export function buildFieldCompletionItems(
  fields: readonly GrpcMessageFieldWire[],
  context: JsonCompletionContext,
): FieldCompletionItem[] {
  const taken = new Set(context.siblings);
  const spokenOneofs = new Set(
    fields.filter((field) => field.oneof !== undefined && taken.has(field.name)).map((field) => field.oneof as string),
  );
  const items: FieldCompletionItem[] = [];
  for (const [index, field] of fields.entries()) {
    if (taken.has(field.name) || (field.oneof !== undefined && spokenOneofs.has(field.oneof))) {
      continue;
    }
    const documentation = documentationOf(field);
    items.push({
      label: field.name,
      insertText: context.quoted ? field.name : `"${field.name}": ${valueSnippet(field)}`,
      detail: detailOf(field),
      ...(documentation !== undefined ? { documentation } : {}),
      sortText: String(index).padStart(4, '0'),
    });
  }
  return items;
}

let registered = false;

/**
 * Registers the JSON completion provider once per renderer process — Monaco's providers are
 * process-global, so a second registration would offer every field twice. Safe to call from every
 * editor that might want completions.
 */
export function registerJsonCompletionOnce(monacoNS: typeof Monaco): void {
  if (registered) {
    return;
  }
  registered = true;
  monacoNS.languages.registerCompletionItemProvider(JSON_LANGUAGE_ID, {
    triggerCharacters: ['"', '{', ','],
    async provideCompletionItems(model, position) {
      const source = sources.get(model.uri.toString());
      if (source === undefined) {
        return { suggestions: [] };
      }
      const context = jsonCompletionContextAt(model.getValue(), model.getOffsetAt(position));
      if (context === undefined) {
        return { suggestions: [] };
      }
      const fields = await source.fetchFields(context.path);
      const start = model.getPositionAt(context.replaceRange.start);
      const end = model.getPositionAt(context.replaceRange.end);
      const range = {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      };
      return {
        suggestions: buildFieldCompletionItems(fields, context).map((item) => ({
          label: item.label,
          kind: monacoNS.languages.CompletionItemKind.Field,
          insertText: item.insertText,
          insertTextRules: monacoNS.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: item.detail,
          sortText: item.sortText,
          range,
          ...(item.documentation !== undefined ? { documentation: { value: item.documentation } } : {}),
        })),
      };
    },
  });
}
