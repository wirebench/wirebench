import { describe, expect, it } from 'vitest';
import { buildApiDocument } from '#protocol-rest/rest/docs/document';
import { apiDocumentToMarkdown } from '#protocol-rest/rest/docs/markdown';
import { apiDocumentToHtml, markdownToSafeHtml } from '#protocol-rest/rest/docs/html';
import { createApi, createFolder, createRestRequest, entry } from '#protocol-rest/rest/model';

const issue = {
  ...createRestRequest('Issue a card', {
    id: 'R2',
    order: 1,
    method: 'POST',
    url: '${base_url}/cards/{programId}',
    description: 'Issues a **virtual** card.',
    pathParams: [entry('programId', '${program_id}')],
    headers: [entry('Authorization', 'Bearer ${secret:token}'), { ...entry('X-Off', 'x'), enabled: false }],
    body: { kind: 'raw', language: 'json', text: '{"type":"virtual"}' },
  }),
  examples: [
    {
      id: 'E1',
      name: 'Created',
      status: 201,
      statusText: 'Created',
      headers: [],
      contentType: 'application/json',
      body: '{"id":"c1"}',
    },
  ],
};
const list = createRestRequest('List cards', { id: 'R1', order: 0, url: '/cards' });
const signIn = createRestRequest('Sign in', { id: 'R0', order: 0, method: 'POST', url: '/auth/token' });

const api = createApi('CaaS', {
  id: 'A1',
  baseUrl: 'https://caas.test',
  description: '# Ignored level\n\nThe whole life of a program.',
  requests: [signIn],
  folders: [
    createFolder('Cards', {
      id: 'F1',
      order: 1,
      description: 'Folder about cards.',
      requests: [issue, list],
      folders: [createFolder('Limits', { id: 'F2', requests: [] })],
    }),
  ],
});

describe('buildApiDocument', () => {
  it('lists folders before requests, each by order, depth-first', () => {
    const doc = buildApiDocument(api, 'Bearer token');
    expect(doc.entries.map((entry) => `${String(entry.depth)}:${entry.name}`)).toEqual([
      '0:Cards',
      '1:Limits',
      '1:List cards',
      '1:Issue a card',
      '0:Sign in',
    ]);
    expect(doc.auth).toBe('Bearer token');
  });

  it('keeps values as written, drops disabled rows, and summarises the body and examples', () => {
    const request = buildApiDocument(api).entries.find((entry) => entry.name === 'Issue a card');
    expect(request).toMatchObject({
      kind: 'request',
      method: 'POST',
      url: '${base_url}/cards/{programId}',
      pathParams: [{ name: 'programId', value: '${program_id}', description: '' }],
      headers: [{ name: 'Authorization', value: 'Bearer ${secret:token}', description: '' }],
      body: { label: 'application/json', text: '{"type":"virtual"}' },
      examples: [{ name: 'Created', status: '201 Created', contentType: 'application/json', body: '{"id":"c1"}' }],
    });
  });

  it('gives every entry a distinct anchor, even under the same name', () => {
    const twins = createApi('Twins', {
      requests: [createRestRequest('Get', { order: 0 }), createRestRequest('Get', { order: 1 })],
    });
    expect(buildApiDocument(twins).entries.map((entry) => entry.anchor)).toEqual(['get', 'get-2']);
  });
});

describe('apiDocumentToMarkdown', () => {
  it('writes the API, a table of contents and every entry, examples in full', () => {
    const markdown = apiDocumentToMarkdown(buildApiDocument(api, 'Bearer token'));
    expect(markdown).toContain('# CaaS\n');
    expect(markdown).toContain('- **Base URL:** `https://caas.test`');
    expect(markdown).toContain('- **Auth:** Bearer token');
    expect(markdown).toContain('  - [POST Issue a card](#issue-a-card)');
    expect(markdown).toContain('`POST ${base_url}/cards/{programId}`');
    expect(markdown).toContain('| Authorization | Bearer $\\{secret:token\\} |  |');
    expect(markdown).not.toContain('X-Off');
    expect(markdown).toContain('```json\n{"id":"c1"}\n```');
  });

  it('keeps a pipe or a backslash in a table value inside its cell', () => {
    const doc = buildApiDocument(
      createApi('Pipes', { requests: [createRestRequest('Get', { headers: [entry('X-Path', 'a|b\\c')] })] }),
    );
    expect(apiDocumentToMarkdown(doc)).toContain('| X\\-Path | a\\|b\\\\c |  |');
  });

  it('escapes names so they stay text', () => {
    const doc = buildApiDocument(createApi('a *b* [c](d)', {}));
    expect(apiDocumentToMarkdown(doc)).toContain('# a \\*b\\* \\[c\\]\\(d\\)');
  });
});

describe('markdownToSafeHtml', () => {
  it('renders Markdown with its headings moved under the section', () => {
    const html = markdownToSafeHtml('# Title\n\n- a\n- b\n\n| A |\n| - |\n| 1 |', 3);
    expect(html).toContain('<h3>Title</h3>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<td>1</td>');
  });

  it('renders no raw HTML, loads no image and keeps no unsafe link', () => {
    const html = markdownToSafeHtml(
      'Hi <script>alert(1)</script> <b>x</b>\n\n<img src="https://evil.test/a.png">\n\n![diagram](https://evil.test/b.png)\n\n[click](javascript:alert(1)) [web](https://ok.test)',
    );
    expect(html).not.toMatch(/<script|<b>|<img/i);
    expect(html).not.toContain('evil.test');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<span>diagram</span>');
    expect(html).toContain('<a href="https://ok.test" rel="noreferrer">web</a>');
    expect(html).toContain('click');
  });

  it('escapes text', () => {
    expect(markdownToSafeHtml('a < b & "c"')).toBe('<p>a &lt; b &amp; &quot;c&quot;</p>\n');
  });
});

describe('apiDocumentToHtml', () => {
  it('is one self-contained page that allows no script and no remote load', () => {
    const html = apiDocumentToHtml(buildApiDocument(api, 'Bearer token'));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`);
    expect(html).not.toMatch(/<script|<link|src=/);
    expect(html).toContain('<section class="request" id="issue-a-card">');
    expect(html).toContain('<code>POST ${base_url}/cards/{programId}</code>');
    expect(html).toContain('<pre><code>{&quot;id&quot;:&quot;c1&quot;}</code></pre>');
  });

  it('escapes every name and value', () => {
    const hostile = createApi('<img src=x onerror=alert(1)>', {
      requests: [createRestRequest('<b>n</b>', { url: '"><script>', headers: [entry('<h>', '<v>')] })],
    });
    const html = apiDocumentToHtml(buildApiDocument(hostile));
    expect(html).not.toMatch(/<img|<b>|<script|<h>|<v>/i);
  });
});
