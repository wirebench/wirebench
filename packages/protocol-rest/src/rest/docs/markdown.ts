/**
 * An {@link ApiDocument} as one Markdown file (API Overview spec §3.3). Descriptions are Markdown
 * already and go in as written; everything else is escaped so a name or a value cannot turn into
 * markup. Response examples are included in full.
 */
import type { ApiDocument, DocParam, DocRequest } from './document.js';

/** A fence longer than any run of backticks in `text`, so the block cannot close early. */
export function fenceFor(text: string): string {
  let length = 3;
  for (const match of text.matchAll(/`{3,}/g)) length = Math.max(length, match[0].length + 1);
  return '`'.repeat(length);
}

/** Inline code that survives backticks inside it. */
function code(text: string): string {
  let ticks = 1;
  for (const match of text.matchAll(/`+/g)) ticks = Math.max(ticks, match[0].length + 1);
  const fence = '`'.repeat(ticks);
  return text.startsWith('`') || text.endsWith('`') ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

/** Plain text that Markdown leaves alone: its punctuation escaped, kept on one line. */
function plain(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/([\\`*_{}[\]()#+\-.!|<>~])/g, '\\$1');
}

function heading(depth: number): string {
  return '#'.repeat(Math.min(6, depth + 2));
}

function table(title: string, rows: readonly DocParam[]): string[] {
  if (rows.length === 0) return [];
  return [
    `**${title}**`,
    '',
    '| Name | Value | Description |',
    '| --- | --- | --- |',
    ...rows.map(
      (row) =>
        // Plain, fully escaped text: a pipe or a backslash in a value can neither end the cell nor
        // escape the character after it, which a code span inside a table cell cannot promise.
        `| ${plain(row.name)} | ${plain(row.value)} | ${plain(row.description)} |`,
    ),
    '',
  ];
}

function block(text: string, language = ''): string[] {
  const fence = fenceFor(text);
  return [`${fence}${language}`, text, fence, ''];
}

function languageOf(contentType: string): string {
  if (/json/i.test(contentType)) return 'json';
  if (/xml/i.test(contentType)) return 'xml';
  if (/html/i.test(contentType)) return 'html';
  if (/graphql/i.test(contentType)) return 'graphql';
  return '';
}

function request(entry: DocRequest): string[] {
  const lines = [
    `${heading(entry.depth + 1)} ${plain(entry.method)} ${plain(entry.name)}`,
    '',
    `<a id="${entry.anchor}"></a>`,
    '',
    code(`${entry.method} ${entry.url}`),
    '',
  ];
  if (entry.description !== '') lines.push(entry.description.trim(), '');
  lines.push(...table('Path parameters', entry.pathParams));
  lines.push(...table('Query parameters', entry.query));
  lines.push(...table('Headers', entry.headers));
  if (entry.body !== undefined) {
    lines.push(`**Body** (${plain(entry.body.label)})`, '', ...block(entry.body.text, languageOf(entry.body.label)));
  }
  if (entry.examples.length > 0) {
    lines.push('**Examples**', '');
    for (const example of entry.examples) {
      const type = example.contentType === '' ? '' : ` · ${plain(example.contentType)}`;
      lines.push(`*${plain(example.name)}* — ${plain(example.status)}${type}`, '');
      if (example.body !== '') lines.push(...block(example.body, languageOf(example.contentType)));
    }
  }
  return lines;
}

export function apiDocumentToMarkdown(doc: ApiDocument): string {
  const lines = [`# ${plain(doc.name)}`, ''];
  if (doc.description !== '') lines.push(doc.description.trim(), '');
  if (doc.baseUrl !== '') lines.push(`- **Base URL:** ${code(doc.baseUrl)}`);
  if (doc.auth !== '') lines.push(`- **Auth:** ${plain(doc.auth)}`);
  if (doc.baseUrl !== '' || doc.auth !== '') lines.push('');

  if (doc.entries.length > 0) {
    lines.push('## Contents', '');
    for (const entry of doc.entries) {
      const label = entry.kind === 'request' ? `${entry.method} ${entry.name}` : entry.name;
      lines.push(`${'  '.repeat(entry.depth)}- [${plain(label)}](#${entry.anchor})`);
    }
    lines.push('');
  }

  for (const entry of doc.entries) {
    if (entry.kind === 'folder') {
      lines.push(`${heading(entry.depth)} ${plain(entry.name)}`, '', `<a id="${entry.anchor}"></a>`, '');
      if (entry.description !== '') lines.push(entry.description.trim(), '');
    } else {
      lines.push(...request(entry));
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
