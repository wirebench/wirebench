/**
 * A REST API's documentation as one plain tree (API Overview spec §3.3): the API, then its folders
 * and requests in the explorer's order, each with its description and what a reader needs to call
 * it. Built once here and rendered three ways — the desktop's docs tab, Markdown and HTML — so the
 * three agree.
 *
 * Nothing is resolved: `${…}` references and secret tokens stay as written, so no value a send would
 * fill in can reach a document.
 */

/** A row of a parameter table: a path parameter, a query parameter or a header. */
export interface DocsParamInput {
  readonly name: string;
  readonly value: string;
  readonly enabled: boolean;
  readonly description?: string | undefined;
}

/** A request body as the model and the desktop's wire both carry it; only what a reader needs is read. */
export type DocsBodyInput =
  | { readonly kind: 'none' }
  | { readonly kind: 'raw'; readonly language: string; readonly contentType?: string | undefined; readonly text: string }
  | { readonly kind: 'form'; readonly fields: readonly DocsParamInput[] }
  | {
      readonly kind: 'multipart';
      readonly parts: readonly { readonly kind: string; readonly name: string; readonly enabled: boolean }[];
    }
  | { readonly kind: 'binary'; readonly contentType: string }
  | { readonly kind: 'graphql'; readonly query: string; readonly variables: string };

export interface DocsExampleInput {
  readonly name: string;
  readonly status: number;
  readonly statusText: string;
  readonly contentType?: string | undefined;
  readonly body?: string | undefined;
}

export interface DocsRequestInput {
  readonly name: string;
  readonly order?: number | undefined;
  readonly description?: string | undefined;
  readonly method: string;
  readonly url: string;
  readonly pathParams: readonly DocsParamInput[];
  readonly query: readonly DocsParamInput[];
  readonly headers: readonly DocsParamInput[];
  readonly body: DocsBodyInput;
  readonly examples?: readonly DocsExampleInput[] | undefined;
}

export interface DocsFolderInput {
  readonly name: string;
  readonly order?: number | undefined;
  readonly description?: string | undefined;
  readonly folders: readonly DocsFolderInput[];
  readonly requests: readonly DocsRequestInput[];
}

export interface DocsApiInput {
  readonly name: string;
  readonly description?: string | undefined;
  readonly baseUrl: string;
  readonly folders: readonly DocsFolderInput[];
  readonly requests: readonly DocsRequestInput[];
}

export interface DocParam {
  readonly name: string;
  readonly value: string;
  readonly description: string;
}

export interface DocBody {
  /** What a reader sees above the block: a content type, "GraphQL". */
  readonly label: string;
  readonly text: string;
}

export interface DocExample {
  readonly name: string;
  readonly status: string;
  readonly contentType: string;
  readonly body: string;
}

export interface DocRequest {
  readonly kind: 'request';
  /** Unique within the document; the anchor a table of contents links to. */
  readonly anchor: string;
  /** Folder depth, 0 at the API's root. */
  readonly depth: number;
  readonly name: string;
  readonly method: string;
  readonly url: string;
  readonly description: string;
  readonly pathParams: readonly DocParam[];
  readonly query: readonly DocParam[];
  readonly headers: readonly DocParam[];
  readonly body?: DocBody;
  readonly examples: readonly DocExample[];
}

export interface DocFolder {
  readonly kind: 'folder';
  readonly anchor: string;
  readonly depth: number;
  readonly name: string;
  readonly description: string;
}

export interface ApiDocument {
  readonly name: string;
  readonly description: string;
  readonly baseUrl: string;
  /** The API's auth as a reader names it ("Bearer token"), or empty when none is set. */
  readonly auth: string;
  /** Folders and requests in the explorer's order, depth-first: a folder, then what it holds. */
  readonly entries: readonly (DocFolder | DocRequest)[];
}

/** Enabled rows only: a disabled one is not sent, so it is not part of how the API is called. */
function params(rows: readonly DocsParamInput[]): DocParam[] {
  return rows
    .filter((row) => row.enabled && row.name !== '')
    .map((row) => ({ name: row.name, value: row.value, description: row.description ?? '' }));
}

const RAW_TYPES: Readonly<Record<string, string>> = {
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  javascript: 'application/javascript',
  text: 'text/plain',
};

function body(input: DocsBodyInput): DocBody | undefined {
  switch (input.kind) {
    case 'none':
      return undefined;
    case 'raw':
      return input.text === ''
        ? undefined
        : { label: input.contentType ?? RAW_TYPES[input.language] ?? 'text/plain', text: input.text };
    case 'form': {
      const rows = params(input.fields);
      return rows.length === 0
        ? undefined
        : {
            label: 'application/x-www-form-urlencoded',
            text: rows.map((row) => `${row.name}=${row.value}`).join('\n'),
          };
    }
    case 'multipart': {
      const parts = input.parts.filter((part) => part.enabled);
      return parts.length === 0
        ? undefined
        : {
            label: 'multipart/form-data',
            text: parts.map((part) => `${part.name} (${part.kind === 'file' ? 'file' : 'text'})`).join('\n'),
          };
    }
    case 'binary':
      return { label: input.contentType, text: '(a file)' };
    case 'graphql':
      return {
        label: 'GraphQL',
        text: input.variables.trim() === '' ? input.query : `${input.query}\n\n# variables\n${input.variables}`,
      };
  }
}

/** A slug for an anchor; numbered on collision so every entry keeps a distinct one. */
function anchorFor(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item';
  let anchor = base;
  for (let n = 2; taken.has(anchor); n += 1) anchor = `${base}-${String(n)}`;
  taken.add(anchor);
  return anchor;
}

function byOrder<T extends { readonly order?: number | undefined }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * The document for one API. `authLabel` names the API's own auth the way the app does; the builder
 * leaves naming to the caller so it carries no table of its own.
 */
export function buildApiDocument(api: DocsApiInput, authLabel = ''): ApiDocument {
  const taken = new Set<string>();
  const entries: (DocFolder | DocRequest)[] = [];

  const visitRequest = (request: DocsRequestInput, depth: number): void => {
    const requestBody = body(request.body);
    entries.push({
      kind: 'request',
      anchor: anchorFor(request.name, taken),
      depth,
      name: request.name,
      method: request.method.toUpperCase(),
      url: request.url,
      description: request.description ?? '',
      pathParams: params(request.pathParams),
      query: params(request.query),
      headers: params(request.headers),
      ...(requestBody !== undefined ? { body: requestBody } : {}),
      examples: (request.examples ?? []).map((example) => ({
        name: example.name,
        status: `${String(example.status)}${example.statusText === '' ? '' : ` ${example.statusText}`}`,
        contentType: example.contentType ?? '',
        body: example.body ?? '',
      })),
    });
  };
  // Folders first, then requests, each by its order: the explorer's arrangement.
  const visitChildren = (
    folders: readonly DocsFolderInput[],
    requests: readonly DocsRequestInput[],
    depth: number,
  ): void => {
    for (const folder of byOrder(folders)) {
      entries.push({
        kind: 'folder',
        anchor: anchorFor(folder.name, taken),
        depth,
        name: folder.name,
        description: folder.description ?? '',
      });
      visitChildren(folder.folders, folder.requests, depth + 1);
    }
    for (const request of byOrder(requests)) visitRequest(request, depth);
  };
  visitChildren(api.folders, api.requests, 0);

  return { name: api.name, description: api.description ?? '', baseUrl: api.baseUrl, auth: authLabel, entries };
}
