import { createHash } from 'node:crypto';
import { Scalar, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { SshModelError } from './errors.js';
import { ENTRY_ID, pathString, readYaml, SECRET_NAME } from './model.js';

export const SNIPPETS_FILE_NAME = 'snippets.yaml';

const NAME = new RegExp(`^${SECRET_NAME.source}$`);
/** A well-formed `${secret:NAME}` token at the start of the text. */
const SECRET_AT = new RegExp(`^\\$\\{secret:${SECRET_NAME.source}\\}`);
/** A declared variable or a secret; any other `${…}` is shell text. */
const TOKEN = new RegExp(`\\$\\{(secret:)?(${SECRET_NAME.source})\\}`, 'g');

const variableSchema = z.strictObject({
  name: z.string(),
  label: z.string().min(1).optional(),
  default: z.string().optional(),
});

const snippetSchema = z.strictObject({
  id: z.string().regex(ENTRY_ID),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).default([]),
  variables: z.array(variableSchema).default([]),
  script: z.string().refine((s) => s.trim().length > 0, 'must not be empty'),
  enter: z.boolean().default(true),
  confirm: z.boolean().default(false),
});

const packageSchema = z.strictObject({
  id: z.string().regex(ENTRY_ID),
  name: z.string().min(1),
  snippets: z.array(snippetSchema).default([]),
});

const fileSchema = z.strictObject({
  version: z.literal(1),
  packages: z.array(packageSchema).default([]),
  snippets: z.array(snippetSchema).default([]),
});

export interface SnippetVariable {
  readonly name: string;
  readonly label?: string;
  readonly default?: string;
}
export interface Snippet {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly variables: readonly SnippetVariable[];
  readonly script: string;
  /** Press Enter after typing (default `true`). */
  readonly enter: boolean;
  /** Always ask before running (default `false`). */
  readonly confirm: boolean;
}
export interface SnippetPackage {
  readonly id: string;
  readonly name: string;
  readonly snippets: readonly Snippet[];
}
export interface SnippetsFile {
  readonly version: 1;
  readonly packages: readonly SnippetPackage[];
  readonly snippets: readonly Snippet[];
}

export const EMPTY_SNIPPETS_FILE: SnippetsFile = { version: 1, packages: [], snippets: [] };

interface Located {
  readonly snippet: Snippet;
  readonly path: string;
  readonly pkg?: SnippetPackage;
}

function located(file: SnippetsFile): Located[] {
  return [
    ...file.packages.flatMap((pkg, p) =>
      pkg.snippets.map((snippet, s) => ({ snippet, pkg, path: `packages[${p}].snippets[${s}]` })),
    ),
    ...file.snippets.map((snippet, s) => ({ snippet, path: `snippets[${s}]` })),
  ];
}

/**
 * @throws SshModelError `snippets-invalid` (YAML or schema, with `details.path`), `snippet-duplicate-id`,
 * `snippet-variable-invalid` or `snippet-secret-invalid`. No message quotes the file's text.
 */
export function parseSnippetsFile(text: string): SnippetsFile {
  const document = readYaml(text, SNIPPETS_FILE_NAME, 'snippets-invalid');
  const raw: unknown = document === null || document === undefined ? { version: 1 } : document;
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = pathString(first?.path ?? []);
    throw new SshModelError('snippets-invalid', `${SNIPPETS_FILE_NAME}: ${path} ${first?.message ?? 'invalid'}`, {
      path,
      issues: parsed.error.issues.map((i) => ({ path: pathString(i.path), message: i.message })),
    });
  }
  const file = parsed.data as SnippetsFile;
  checkIds(file);
  for (const entry of located(file)) {
    checkVariables(entry);
    checkSecrets(entry);
  }
  return file;
}

function checkIds(file: SnippetsFile): void {
  const seen = new Map<string, string>();
  const claim = (id: string, path: string): void => {
    const previous = seen.get(id);
    if (previous !== undefined) {
      throw new SshModelError('snippet-duplicate-id', `id "${id}" is used at ${previous} and ${path}`, {
        id,
        path,
        paths: [previous, path],
      });
    }
    seen.set(id, path);
  };
  file.packages.forEach((pkg, p) => claim(pkg.id, `packages[${p}]`));
  for (const { snippet, path } of located(file)) claim(snippet.id, path);
}

function checkVariables({ snippet, path }: Located): void {
  const names = new Set<string>();
  snippet.variables.forEach((variable, v) => {
    const why = !NAME.test(variable.name)
      ? 'is not a valid name'
      : variable.name === 'secret'
        ? 'is reserved'
        : names.has(variable.name)
          ? 'is declared twice'
          : undefined;
    if (why !== undefined) {
      throw new SshModelError(
        'snippet-variable-invalid',
        `snippet "${snippet.id}": variable "${variable.name}" ${why}`,
        { snippet: snippet.id, variable: variable.name, path: `${path}.variables[${v}].name` },
      );
    }
    names.add(variable.name);
  });
}

function checkSecrets({ snippet, path }: Located): void {
  const refuse = (field: string, why: string): never => {
    throw new SshModelError('snippet-secret-invalid', `snippet "${snippet.id}": ${field} ${why}`, {
      snippet: snippet.id,
      field,
      path: `${path}.${field}`,
    });
  };
  const script = snippet.script;
  for (let at = script.indexOf('${secret:'); at !== -1; at = script.indexOf('${secret:', at + 1)) {
    if (!SECRET_AT.test(script.slice(at))) refuse('script', 'holds a malformed ${secret:NAME} token');
  }
  snippet.variables.forEach((variable, v) => {
    if (variable.default?.includes('${secret:')) {
      refuse(`variables[${v}].default`, 'may not hold a ${secret:…} token; write the secret in the script');
    }
  });
}

/** The snippet as written, without its defaults; `script` is a block scalar when it holds a line break. */
function snippetNode(s: Snippet): Record<string, unknown> {
  const out: Record<string, unknown> = { id: s.id, name: s.name };
  if (s.description !== undefined) out['description'] = s.description;
  if (s.tags.length > 0) out['tags'] = [...s.tags];
  if (s.variables.length > 0) {
    out['variables'] = s.variables.map((v) => ({
      name: v.name,
      ...(v.label === undefined ? {} : { label: v.label }),
      ...(v.default === undefined ? {} : { default: v.default }),
    }));
  }
  if (s.script.includes('\n')) {
    const block = new Scalar(s.script);
    block.type = Scalar.BLOCK_LITERAL;
    out['script'] = block;
  } else {
    out['script'] = s.script;
  }
  if (!s.enter) out['enter'] = false;
  if (s.confirm) out['confirm'] = true;
  return out;
}

export function serializeSnippetsFile(file: SnippetsFile): string {
  const out: Record<string, unknown> = { version: file.version };
  if (file.packages.length > 0) {
    out['packages'] = file.packages.map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      ...(pkg.snippets.length > 0 ? { snippets: pkg.snippets.map(snippetNode) } : {}),
    }));
  }
  if (file.snippets.length > 0) out['snippets'] = file.snippets.map(snippetNode);
  return stringifyYaml(out, { lineWidth: 0 });
}

export interface SnippetListItem {
  readonly id: string;
  readonly name: string;
  readonly packageId?: string;
  readonly packageName?: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly firstLine: string;
  /** The first line up to its first `${`: what an inline suggestion matches. */
  readonly literalStart: string;
  readonly variables: readonly SnippetVariable[];
  /** Secret names the script uses, in order of first use, unique. */
  readonly secrets: readonly string[];
  readonly enter: boolean;
  readonly confirm: boolean;
  readonly lineCount: number;
  /** SHA-256 hex of the snippet's canonical serialisation: a run refuses a snippet that changed since. */
  readonly revision: string;
}

const normalise = (script: string): string => script.replace(/\r\n?/g, '\n');
const lines = (script: string): string[] => normalise(script).replace(/\n$/, '').split('\n');

/** Secret names `script` uses, in order of first use, unique. */
export function snippetSecrets(script: string): string[] {
  const names = new Set<string>();
  for (const match of script.matchAll(TOKEN)) if (match[1] !== undefined && match[2]) names.add(match[2]);
  return [...names];
}

export function snippetRevision(snippet: Snippet): string {
  return createHash('sha256')
    .update(stringifyYaml(snippetNode(snippet), { lineWidth: 0 }))
    .digest('hex');
}

export function listSnippets(file: SnippetsFile): SnippetListItem[] {
  return located(file).map(({ snippet, pkg }) => {
    const all = lines(snippet.script);
    const firstLine = all[0] ?? '';
    const token = firstLine.indexOf('${');
    return {
      id: snippet.id,
      name: snippet.name,
      ...(pkg ? { packageId: pkg.id, packageName: pkg.name } : {}),
      ...(snippet.description === undefined ? {} : { description: snippet.description }),
      tags: snippet.tags,
      firstLine,
      literalStart: token === -1 ? firstLine : firstLine.slice(0, token),
      variables: snippet.variables,
      secrets: snippetSecrets(snippet.script),
      enter: snippet.enter,
      confirm: snippet.confirm,
      lineCount: all.length,
      revision: snippetRevision(snippet),
    };
  });
}

export function findSnippet(file: SnippetsFile, id: string): Snippet | undefined {
  return located(file).find((entry) => entry.snippet.id === id)?.snippet;
}

/** What a secret looks like wherever its value must not show: a preview, a masked session. */
export const SECRET_MASK = '••••';

/** A line break or any other control character: a value holding one could type a second command line. */
const hasControl = (value: string): boolean =>
  [...value].some((c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });

export interface Expansion {
  readonly text: string;
  /** The secret values put into `text`, for the session masker. */
  readonly secretValues: readonly string[];
}

/** One left-to-right pass: an inserted value is never scanned again, so a `${…}` inside it stays as written. */
function expand(snippet: Snippet, values: Readonly<Record<string, string>>, secret: (name: string) => string): string {
  const declared = new Map(snippet.variables.map((v) => [v.name, v]));
  const script = normalise(snippet.script).replace(/\n$/, '');
  return script.replace(TOKEN, (token, isSecret: string | undefined, name: string) => {
    if (isSecret !== undefined) return secret(name);
    const variable = declared.get(name);
    if (variable === undefined) return token;
    const value = Object.hasOwn(values, name) ? values[name] : variable.default;
    const details = { snippet: snippet.id, variable: name };
    if (value === undefined) {
      throw new SshModelError('snippet-variable-missing', `snippet "${snippet.id}": "${name}" has no value`, details);
    }
    if (hasControl(value)) {
      throw new SshModelError(
        'snippet-value-invalid',
        `snippet "${snippet.id}": the value of "${name}" holds a line break or a control character`,
        details,
      );
    }
    return value;
  });
}

/**
 * Replaces declared `${name}` with `values` (else the default) and `${secret:NAME}` with `secrets`; any other
 * `${…}` is left for the shell. Line endings become `\n` and one trailing line break is dropped.
 * @throws SshModelError `snippet-variable-missing` | `snippet-value-invalid`; a plain `Error` for a secret
 * missing from `secrets` (the caller resolves every name in `snippetSecrets` first). No error holds a value.
 */
export function expandSnippet(
  snippet: Snippet,
  values: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, string>>,
): Expansion {
  const used = new Set<string>();
  const text = expand(snippet, values, (name) => {
    const value = Object.hasOwn(secrets, name) ? secrets[name] : undefined;
    if (value === undefined) throw new Error(`secret "${name}" was not resolved before expanding`);
    used.add(value);
    return value;
  });
  return { text, secretValues: [...used] };
}

/** The expansion with every secret as {@link SECRET_MASK}; needs no secret. Same refusals as `expandSnippet`. */
export function previewSnippet(snippet: Snippet, values: Readonly<Record<string, string>>): string {
  return expand(snippet, values, () => SECRET_MASK);
}
