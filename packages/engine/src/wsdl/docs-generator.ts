/**
 * SoapUI-style "Generate Documentation": renders an imported definition as a
 * single self-contained document — HTML (inline CSS, no scripts, everything
 * escaped) or Markdown (with a table of contents).
 *
 * Pure and deterministic: the same {@link ImportResult} always produces
 * byte-identical output, so the golden tests are meaningful and a regenerated
 * document is a clean diff. Nothing is fetched; every byte comes from the
 * bundle the import already resolved.
 */

import type { SchemaSet } from '../xsd/schema-set.js';
import type { ImportResult } from '../types.js';
import type { Binding, BindingOperation, Message, Operation, Part, WsdlDefinition } from './model.js';
import { findBinding, findMessage, findPortType } from './model.js';
import type { QName } from './qname.js';
import { qnameToString } from './qname.js';

/** Options accepted by {@link generateDocs}. */
export interface GenerateDocsOptions {
  readonly format: 'html' | 'markdown';
  /** Document title; defaults to the first service's name, then the definition's file name. */
  readonly title?: string;
}

/** A generic "name: value" row of the rendered document. */
interface Field {
  readonly label: string;
  readonly value: string;
}

/** One rendered section: a heading, optional intro fields, and zero or more sub-blocks. */
interface Block {
  readonly heading: string;
  readonly fields?: readonly Field[];
  readonly paragraphs?: readonly string[];
  readonly table?: { readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] };
  readonly code?: string;
  readonly children?: readonly Block[];
}

const EMPTY = '—';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escapes the Markdown characters that would break a one-line table cell. */
function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** A stable, URL-safe anchor for a heading, deduplicated by the caller's `taken` set. */
function anchorOf(heading: string, taken: Set<string>): string {
  const base =
    heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section';
  let anchor = base;
  let n = 2;
  while (taken.has(anchor)) {
    anchor = `${base}-${String(n)}`;
    n += 1;
  }
  taken.add(anchor);
  return anchor;
}

/** `{ns}local` for a QName, or the empty marker when there is none. */
function clark(name: QName | undefined): string {
  return name === undefined ? EMPTY : qnameToString(name);
}

/** How one `wsdl:part` binds to the schema: an element reference, a type reference, or neither. */
function partTarget(part: Part): string {
  if (part.element !== undefined) {
    return `element ${qnameToString(part.element)}`;
  }
  if (part.type !== undefined) {
    return `type ${qnameToString(part.type)}`;
  }
  return EMPTY;
}

/** The `wsdl:message` a message reference points at, when the merged definition has it. */
function messageParts(definition: WsdlDefinition, name: QName | undefined): string {
  if (name === undefined) {
    return EMPTY;
  }
  const message: Message | undefined = findMessage(definition, name);
  if (message === undefined || message.parts.length === 0) {
    return qnameToString(name);
  }
  return `${qnameToString(name)} (${message.parts.map((part) => `${part.name}: ${partTarget(part)}`).join(', ')})`;
}

/**
 * The XML source of the element that starts on `line` (1-based) of `text`, capped at
 * `maxLines`. Textual rather than DOM-based on purpose: the point is to show the author's own
 * markup, comments and formatting, not a re-serialisation of it. An attribute value containing
 * a literal `>` would end the snippet early — vanishingly rare in a schema, and worth the
 * simplicity of not carrying a second parser here.
 *
 * @param text the whole document the declaration lives in
 * @param line the 1-based line the declaration's start tag opens on
 * @param maxLines how many lines to keep before cutting the snippet with an ellipsis
 * @returns the declaration's source, dedented, or `''` when `line` is out of range
 */
export function sourceSnippet(text: string, line: number, maxLines = 30): string {
  const lines = text.split(/\r?\n/);
  if (line < 1 || line > lines.length) {
    return '';
  }
  // Work on the split lines rather than a character offset into `text`: the document may use
  // CRLF, and a byte offset computed from LF-joined lines would drift by one per preceding line.
  const rest = lines.slice(line - 1).join('\n');
  const open = /<\s*([^\s/>!?]+)/.exec(rest);
  if (open?.[1] === undefined) {
    return dedent([lines[line - 1] ?? '']);
  }
  const tag = open[1];
  const pattern = new RegExp(`<(/?)${escapeRegExp(tag)}(\\s[^>]*?)?(/?)>`, 'g');
  let depth = 0;
  let end = -1;
  for (const match of rest.matchAll(pattern)) {
    const closing = match[1] === '/';
    const selfClosing = match[3] === '/';
    if (closing) {
      depth -= 1;
    } else if (!selfClosing) {
      depth += 1;
    }
    if (depth <= 0) {
      end = match.index + match[0].length;
      break;
    }
  }
  const source = end === -1 ? rest : rest.slice(0, end);
  const collected = source.split(/\r?\n/);
  const capped = collected.slice(0, maxLines);
  const truncated = capped.length < collected.length || end === -1;
  return truncated ? `${dedent(capped)}\n…` : dedent(capped);
}

/** Strips the first line's leading whitespace from every line that starts with it. */
function dedent(lines: readonly string[]): string {
  const indent = /^\s*/.exec(lines[0] ?? '')?.[0] ?? '';
  if (indent === '') {
    return lines.join('\n');
  }
  return lines.map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line.trimStart())).join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The bundle's document texts, keyed by canonical location. */
function textsOf(result: ImportResult): ReadonlyMap<string, string> {
  return new Map(result.bundle.documents.map((document) => [document.location, document.text]));
}

/** The overview block: where the definition came from, and what it is made of. */
function overviewBlock(result: ImportResult, title: string): Block {
  const { definition, bundle, schemaSet } = result;
  return {
    heading: 'Overview',
    fields: [
      { label: 'Title', value: title },
      { label: 'Definition', value: bundle.root.location },
      { label: 'Target namespace', value: definition.targetNamespace || EMPTY },
      { label: 'Documents', value: String(bundle.documents.length) },
      { label: 'Operations', value: String(result.operations.length) },
      { label: 'Schema namespaces', value: schemaSet.namespaces.length > 0 ? schemaSet.namespaces.join(', ') : EMPTY },
    ],
    ...(definition.documentation !== undefined ? { paragraphs: [definition.documentation] } : {}),
    table: {
      columns: ['Document', 'Kind', 'Namespace'],
      rows: bundle.documents.map((document) => [document.location, document.kind, document.namespace ?? EMPTY]),
    },
  };
}

function servicesBlock(definition: WsdlDefinition): Block {
  const rows: string[][] = [];
  for (const service of definition.services) {
    for (const port of service.ports) {
      const binding = findBinding(definition, port.binding);
      rows.push([
        service.name.localName,
        port.name,
        clark(port.binding),
        binding?.soapVersion ?? EMPTY,
        port.address ?? EMPTY,
      ]);
    }
  }
  return {
    heading: 'Services and ports',
    table: { columns: ['Service', 'Port', 'Binding', 'SOAP', 'Address'], rows },
  };
}

function bindingsBlock(definition: WsdlDefinition): Block {
  return {
    heading: 'Bindings',
    table: {
      columns: ['Binding', 'Port type', 'SOAP', 'Style', 'Transport', 'Operations'],
      rows: definition.bindings.map((binding: Binding) => [
        clark(binding.name),
        clark(binding.type),
        binding.soapVersion,
        binding.style,
        binding.transport ?? EMPTY,
        binding.operations.map((operation) => operation.name).join(', ') || EMPTY,
      ]),
    },
  };
}

/** One operation's own sub-block: transport metadata, documentation and its messages. */
function operationBlock(definition: WsdlDefinition, binding: Binding, bindingOperation: BindingOperation): Block {
  const portType = findPortType(definition, binding.type);
  const abstract: Operation | undefined = portType?.operations.find(
    (candidate) => candidate.name === bindingOperation.name,
  );
  const rows: string[][] = [
    ['Input', messageParts(definition, abstract?.input?.message)],
    ['Output', messageParts(definition, abstract?.output?.message)],
  ];
  for (const fault of abstract?.faults ?? []) {
    rows.push([`Fault "${fault.name}"`, messageParts(definition, fault.message)]);
  }
  const headers = [...(bindingOperation.input?.headers ?? []), ...(bindingOperation.output?.headers ?? [])];
  for (const header of headers) {
    rows.push(['SOAP header', `${qnameToString(header.message)} part ${header.part} (${header.use})`]);
  }
  return {
    heading: `${binding.name.localName}.${bindingOperation.name}`,
    fields: [
      { label: 'SOAPAction', value: bindingOperation.soapAction ?? EMPTY },
      { label: 'Style', value: bindingOperation.style ?? binding.style },
      { label: 'Use', value: bindingOperation.input?.body.use ?? EMPTY },
      { label: 'SOAP version', value: binding.soapVersion },
    ],
    ...(abstract?.documentation !== undefined ? { paragraphs: [abstract.documentation] } : {}),
    table: { columns: ['Message', 'Details'], rows },
  };
}

function operationsBlock(definition: WsdlDefinition): Block {
  const children: Block[] = [];
  for (const binding of definition.bindings) {
    for (const operation of binding.operations) {
      children.push(operationBlock(definition, binding, operation));
    }
  }
  return { heading: 'Operations', children };
}

function messagesBlock(definition: WsdlDefinition): Block {
  const rows: string[][] = [];
  for (const message of definition.messages) {
    if (message.parts.length === 0) {
      rows.push([clark(message.name), EMPTY, EMPTY]);
      continue;
    }
    for (const part of message.parts) {
      rows.push([clark(message.name), part.name, partTarget(part)]);
    }
  }
  return { heading: 'Messages', table: { columns: ['Message', 'Part', 'Binds to'], rows } };
}

/** One schema component's sub-block: its kind, its type reference and the XML that declares it. */
function componentBlock(
  kind: string,
  name: string,
  typeName: QName | undefined,
  source: { readonly location: string; readonly line?: number },
  texts: ReadonlyMap<string, string>,
): Block {
  const text = texts.get(source.location);
  const snippet = text !== undefined && source.line !== undefined ? sourceSnippet(text, source.line) : '';
  return {
    heading: `${kind} ${name}`,
    fields: [
      { label: 'Type', value: clark(typeName) },
      {
        label: 'Declared in',
        value: `${source.location}${source.line !== undefined ? `:${String(source.line)}` : ''}`,
      },
    ],
    ...(snippet !== '' ? { code: snippet } : {}),
  };
}

function schemaBlock(schemaSet: SchemaSet, texts: ReadonlyMap<string, string>): Block {
  const children: Block[] = [];
  for (const uri of [...schemaSet.namespaces].sort((a, b) => a.localeCompare(b))) {
    const components: Block[] = [];
    for (const element of [...schemaSet.elementsInNamespace(uri)].sort((a, b) =>
      a.name.localName.localeCompare(b.name.localName),
    )) {
      components.push(componentBlock('element', element.name.localName, element.type, element.source, texts));
    }
    for (const type of [...schemaSet.typesInNamespace(uri)].sort((a, b) =>
      (a.name?.localName ?? '').localeCompare(b.name?.localName ?? ''),
    )) {
      if (type.name === undefined) {
        continue;
      }
      components.push(componentBlock(type.kind, type.name.localName, undefined, type.source, texts));
    }
    children.push({ heading: `Namespace ${uri === '' ? '(no namespace)' : uri}`, children: components });
  }
  return { heading: 'Schema components', children };
}

/** The document's title: the caller's, then the first service's name, then the root file name. */
function titleOf(result: ImportResult, options: GenerateDocsOptions): string {
  if (options.title !== undefined && options.title.trim() !== '') {
    return options.title.trim();
  }
  const service = result.definition.services[0];
  if (service !== undefined) {
    return service.name.localName;
  }
  return result.bundle.root.location.split('/').pop() ?? 'Definition';
}

function renderHtmlBlock(block: Block, level: number, taken: Set<string>): string {
  const tag = `h${String(Math.min(level, 6))}`;
  const anchor = anchorOf(block.heading, taken);
  const parts: string[] = [`<${tag} id="${escapeHtml(anchor)}">${escapeHtml(block.heading)}</${tag}>`];
  if (block.fields !== undefined && block.fields.length > 0) {
    parts.push(
      `<dl>${block.fields
        .map((field) => `<dt>${escapeHtml(field.label)}</dt><dd>${escapeHtml(field.value)}</dd>`)
        .join('')}</dl>`,
    );
  }
  for (const paragraph of block.paragraphs ?? []) {
    parts.push(`<p>${escapeHtml(paragraph)}</p>`);
  }
  if (block.table !== undefined && block.table.rows.length > 0) {
    const head = block.table.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');
    const body = block.table.rows
      .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
      .join('');
    parts.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
  }
  if (block.code !== undefined) {
    parts.push(`<pre><code>${escapeHtml(block.code)}</code></pre>`);
  }
  for (const child of block.children ?? []) {
    parts.push(renderHtmlBlock(child, level + 1, taken));
  }
  return parts.join('\n');
}

/** Inline stylesheet of the HTML document; no external resources, no scripts. */
const HTML_STYLE = `
:root { color-scheme: light dark; }
body { font: 15px/1.55 -apple-system, "Segoe UI", system-ui, sans-serif; margin: 0 auto; max-width: 60rem; padding: 2rem 1.5rem; }
h1 { font-size: 1.9rem; margin-bottom: 0.25rem; }
h2 { border-bottom: 1px solid currentColor; margin-top: 2.5rem; padding-bottom: 0.2rem; }
h3, h4 { margin-top: 1.75rem; }
dl { display: grid; gap: 0.15rem 1rem; grid-template-columns: max-content 1fr; margin: 0.5rem 0; }
dt { font-weight: 600; }
dd { margin: 0; overflow-wrap: anywhere; }
table { border-collapse: collapse; display: block; margin: 0.75rem 0; overflow-x: auto; width: 100%; }
th, td { border: 1px solid rgba(128,128,128,0.45); padding: 0.3rem 0.55rem; text-align: left; vertical-align: top; }
th { background: rgba(128,128,128,0.14); }
pre { background: rgba(128,128,128,0.12); border-radius: 4px; overflow-x: auto; padding: 0.6rem 0.8rem; }
code { font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
nav ol { padding-left: 1.2rem; }
footer { color: rgba(128,128,128,1); font-size: 0.85rem; margin-top: 3rem; }
`.trim();

function renderHtml(title: string, blocks: readonly Block[]): string {
  const taken = new Set<string>();
  const toc = blocks.map((block) => ({ heading: block.heading, anchor: anchorOf(block.heading, new Set(taken)) }));
  const body = blocks.map((block) => renderHtmlBlock(block, 2, taken)).join('\n');
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>\n${HTML_STYLE}\n</style>`,
    '</head>',
    '<body>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<nav><ol>${toc
      .map((entry) => `<li><a href="#${escapeHtml(entry.anchor)}">${escapeHtml(entry.heading)}</a></li>`)
      .join('')}</ol></nav>`,
    body,
    '<footer>Generated by Wirebench.</footer>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function renderMarkdownBlock(block: Block, level: number): string {
  const parts: string[] = [`${'#'.repeat(Math.min(level, 6))} ${block.heading}`];
  if (block.fields !== undefined && block.fields.length > 0) {
    parts.push(block.fields.map((field) => `- **${field.label}:** ${escapeMarkdownCell(field.value)}`).join('\n'));
  }
  for (const paragraph of block.paragraphs ?? []) {
    parts.push(paragraph);
  }
  if (block.table !== undefined && block.table.rows.length > 0) {
    const head = `| ${block.table.columns.join(' | ')} |`;
    const rule = `| ${block.table.columns.map(() => '---').join(' | ')} |`;
    const rows = block.table.rows.map((row) => `| ${row.map(escapeMarkdownCell).join(' | ')} |`);
    parts.push([head, rule, ...rows].join('\n'));
  }
  if (block.code !== undefined) {
    parts.push(['```xml', block.code, '```'].join('\n'));
  }
  for (const child of block.children ?? []) {
    parts.push(renderMarkdownBlock(child, level + 1));
  }
  return parts.join('\n\n');
}

function renderMarkdown(title: string, blocks: readonly Block[]): string {
  const taken = new Set<string>();
  const toc = blocks.map((block) => `- [${block.heading}](#${anchorOf(block.heading, taken)})`);
  return [
    `# ${title}`,
    '## Contents',
    toc.join('\n'),
    ...blocks.map((block) => renderMarkdownBlock(block, 2)),
    '---',
    'Generated by Wirebench.',
    '',
  ].join('\n\n');
}

/**
 * Renders `result` as a complete, self-contained document — a single HTML page
 * or a single Markdown file — covering the definition's services and ports,
 * bindings, operations (with their messages and SOAP headers), messages and
 * global schema components with the XML that declares them.
 *
 * @param result the imported definition to document
 * @param options output format and an optional title
 * @returns the whole document as a string; the caller decides where it lands
 */
export function generateDocs(result: ImportResult, options: GenerateDocsOptions): string {
  const title = titleOf(result, options);
  const texts = textsOf(result);
  const blocks: Block[] = [
    overviewBlock(result, title),
    servicesBlock(result.definition),
    bindingsBlock(result.definition),
    operationsBlock(result.definition),
    messagesBlock(result.definition),
    schemaBlock(result.schemaSet, texts),
  ];
  return options.format === 'html' ? renderHtml(title, blocks) : renderMarkdown(title, blocks);
}
