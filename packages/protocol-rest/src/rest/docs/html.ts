/**
 * An {@link ApiDocument} as one self-contained HTML page (API Overview spec §3.3): inline CSS, no
 * script, light and dark. Descriptions are untrusted Markdown, so they are parsed and rebuilt here
 * rather than handed to a renderer: every piece of text is escaped, raw HTML in the source is
 * dropped, an image is never emitted (its alt text stands in, so opening the file fetches nothing),
 * and only http(s) and mailto links survive.
 */
import type { Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { ApiDocument, DocParam, DocRequest } from './document.js';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A link target a reader may follow out of the file; anything else becomes plain text. */
function safeUrl(url: string): string | undefined {
  return /^(https?:\/\/|mailto:)/i.test(url.trim()) ? url.trim() : undefined;
}

function children(node: { readonly children?: readonly Nodes[] }, headingShift: number): string {
  return (node.children ?? []).map((child) => render(child, headingShift)).join('');
}

/** One mdast node as HTML. Headings move down by `headingShift` so they sit under the section's own. */
function render(node: Nodes, headingShift: number): string {
  switch (node.type) {
    case 'root':
      return children(node, headingShift);
    case 'paragraph':
      return `<p>${children(node, headingShift)}</p>\n`;
    case 'heading': {
      const level = Math.min(6, node.depth + headingShift);
      return `<h${String(level)}>${children(node, headingShift)}</h${String(level)}>\n`;
    }
    case 'text':
      return escapeHtml(node.value);
    case 'emphasis':
      return `<em>${children(node, headingShift)}</em>`;
    case 'strong':
      return `<strong>${children(node, headingShift)}</strong>`;
    case 'delete':
      return `<del>${children(node, headingShift)}</del>`;
    case 'inlineCode':
      return `<code>${escapeHtml(node.value)}</code>`;
    case 'code':
      return `<pre><code>${escapeHtml(node.value)}</code></pre>\n`;
    case 'blockquote':
      return `<blockquote>${children(node, headingShift)}</blockquote>\n`;
    case 'list': {
      const tag = node.ordered === true ? 'ol' : 'ul';
      const start = node.ordered === true && node.start !== null && node.start !== undefined && node.start !== 1;
      return `<${tag}${start ? ` start="${String(node.start)}"` : ''}>\n${children(node, headingShift)}</${tag}>\n`;
    }
    case 'listItem': {
      const box = node.checked === true ? '☑ ' : node.checked === false ? '☐ ' : '';
      // A tight list's paragraphs read as plain lines.
      const inner = node.children
        .map((child) =>
          node.spread !== true && child.type === 'paragraph'
            ? children(child, headingShift)
            : render(child, headingShift),
        )
        .join('');
      return `<li>${box}${inner}</li>\n`;
    }
    case 'thematicBreak':
      return '<hr>\n';
    case 'break':
      return '<br>';
    case 'link': {
      const url = safeUrl(node.url);
      const inner = children(node, headingShift);
      return url === undefined ? inner : `<a href="${escapeHtml(url)}" rel="noreferrer">${inner}</a>`;
    }
    case 'image':
    case 'imageReference':
      return node.alt === null || node.alt === undefined || node.alt === ''
        ? ''
        : `<span>${escapeHtml(node.alt)}</span>`;
    case 'linkReference':
      return children(node, headingShift);
    case 'table': {
      const [head, ...rows] = node.children;
      const cells = (row: (typeof node.children)[number], tag: 'th' | 'td'): string =>
        `<tr>${row.children.map((one) => `<${tag}>${children(one, headingShift)}</${tag}>`).join('')}</tr>`;
      return `<table>\n${head === undefined ? '' : `<thead>${cells(head, 'th')}</thead>\n`}<tbody>${rows
        .map((row) => cells(row, 'td'))
        .join('\n')}</tbody>\n</table>\n`;
    }
    // Raw HTML, definitions, footnotes and anything else the source carries: not rendered.
    default:
      return '';
  }
}

/** Untrusted Markdown as safe HTML; headings start at `minHeading` and below. */
export function markdownToSafeHtml(source: string, minHeading = 3): string {
  const tree: Root = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return render(tree, minHeading - 1);
}

function table(title: string, rows: readonly DocParam[]): string {
  if (rows.length === 0) return '';
  const body = rows
    .map(
      (row) =>
        `<tr><td><code>${escapeHtml(row.name)}</code></td><td>${
          row.value === '' ? '' : `<code>${escapeHtml(row.value)}</code>`
        }</td><td>${escapeHtml(row.description)}</td></tr>`,
    )
    .join('\n');
  return `<p class="label">${escapeHtml(title)}</p>
<table><thead><tr><th>Name</th><th>Value</th><th>Description</th></tr></thead><tbody>
${body}
</tbody></table>`;
}

function heading(depth: number): number {
  return Math.min(6, depth + 2);
}

function request(entry: DocRequest): string {
  const level = heading(entry.depth + 1);
  const parts = [
    `<section class="request" id="${entry.anchor}">`,
    `<h${String(level)}><span class="method">${escapeHtml(entry.method)}</span> ${escapeHtml(entry.name)}</h${String(level)}>`,
    `<p><code>${escapeHtml(`${entry.method} ${entry.url}`)}</code></p>`,
  ];
  if (entry.description !== '') parts.push(markdownToSafeHtml(entry.description, level + 1));
  parts.push(table('Path parameters', entry.pathParams));
  parts.push(table('Query parameters', entry.query));
  parts.push(table('Headers', entry.headers));
  if (entry.body !== undefined) {
    parts.push(
      `<p class="label">Body <span class="muted">(${escapeHtml(entry.body.label)})</span></p>`,
      `<pre><code>${escapeHtml(entry.body.text)}</code></pre>`,
    );
  }
  if (entry.examples.length > 0) {
    parts.push('<p class="label">Examples</p>');
    for (const example of entry.examples) {
      const type = example.contentType === '' ? '' : ` · ${escapeHtml(example.contentType)}`;
      parts.push(`<p><em>${escapeHtml(example.name)}</em> — ${escapeHtml(example.status)}${type}</p>`);
      if (example.body !== '') parts.push(`<pre><code>${escapeHtml(example.body)}</code></pre>`);
    }
  }
  parts.push('</section>');
  return parts.filter((part) => part !== '').join('\n');
}

const STYLE = `
:root { color-scheme: light dark; --fg: #22201d; --muted: #6d675f; --line: #e3ded6; --code: #f4f1ec; --accent: #a94d2b; }
@media (prefers-color-scheme: dark) { :root { --fg: #ece9e3; --muted: #a49d93; --line: #3a3631; --code: #23211e; --accent: #d97757; } }
body { margin: 0 auto; max-width: 52rem; padding: 2rem 1.25rem 4rem; font: 15px/1.6 system-ui, sans-serif; color: var(--fg); background: Canvas; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.6em 0 0.5em; }
a { color: var(--accent); }
code { font: 0.9em ui-monospace, monospace; background: var(--code); padding: 0.1em 0.3em; border-radius: 4px; }
pre { background: var(--code); padding: 0.75rem; border-radius: 6px; overflow-x: auto; }
pre code { padding: 0; background: none; }
table { border-collapse: collapse; width: 100%; margin: 0.5em 0 1em; font-size: 0.95em; }
th, td { border: 1px solid var(--line); padding: 0.3em 0.5em; text-align: left; vertical-align: top; }
blockquote { margin: 0; padding-left: 1em; border-left: 3px solid var(--line); color: var(--muted); }
.request { border-top: 1px solid var(--line); margin-top: 2rem; }
.method { font: 600 0.8em ui-monospace, monospace; color: var(--accent); }
.label { font-weight: 600; margin-bottom: 0.25em; }
.muted, .meta { color: var(--muted); }
nav ul { padding-left: 1.25em; }
`;

export function apiDocumentToHtml(doc: ApiDocument): string {
  const meta = [
    doc.baseUrl === '' ? '' : `<li>Base URL: <code>${escapeHtml(doc.baseUrl)}</code></li>`,
    doc.auth === '' ? '' : `<li>Auth: ${escapeHtml(doc.auth)}</li>`,
  ].filter((line) => line !== '');

  const toc = doc.entries
    .map((entry) => {
      const label = entry.kind === 'request' ? `${entry.method} ${entry.name}` : entry.name;
      return `<li style="margin-left:${String(entry.depth * 1.25)}em"><a href="#${entry.anchor}">${escapeHtml(label)}</a></li>`;
    })
    .join('\n');

  const body = doc.entries
    .map((entry) => {
      if (entry.kind === 'request') return request(entry);
      const level = heading(entry.depth);
      const description = entry.description === '' ? '' : markdownToSafeHtml(entry.description, level + 1);
      return `<section class="folder" id="${entry.anchor}">\n<h${String(level)}>${escapeHtml(entry.name)}</h${String(level)}>\n${description}</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(doc.name)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${escapeHtml(doc.name)}</h1>
${doc.description === '' ? '' : markdownToSafeHtml(doc.description, 2)}
${meta.length === 0 ? '' : `<ul class="meta">${meta.join('')}</ul>`}
${toc === '' ? '' : `<nav><h2>Contents</h2><ul>\n${toc}\n</ul></nav>`}
${body}
</body>
</html>
`;
}
