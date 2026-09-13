/**
 * File-system naming and layout for a project folder.
 *
 * Display names live inside the YAML; the folder/file names are `slugify(name)`
 * so a project stays readable and diffable in git while remaining portable
 * across Windows, macOS and Linux.
 */

import { join } from 'node:path';
import { ProjectError } from '../errors.js';

/** Longest slug we emit; leaves room for the `.request.yaml` suffix within common path limits. */
const MAX_SLUG_LENGTH = 80;

/** Characters that are illegal in a path segment on at least one supported OS. */
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

/** Device names Windows refuses to use as a file name, with or without an extension. */
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Derives a portable file-system name from a display name.
 *
 * Case is preserved (a folder called `CountryInfo` should read as `CountryInfo`);
 * whitespace runs collapse to a single space; characters illegal on any
 * supported OS become `_`; leading/trailing dots and spaces are replaced by a
 * single `_`; the result is capped at 80 characters and never empty.
 */
export function slugify(name: string): string {
  let slug = name.replace(/\s+/g, ' ').replace(ILLEGAL_CHARS, '_');
  slug = slug.trim();
  slug = slug.replace(/^[. ]+/, '_').replace(/[. ]+$/, '_');
  if (slug.length > MAX_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_SLUG_LENGTH).replace(/[. ]+$/, '_');
  }
  if (slug === '') {
    return 'unnamed';
  }
  return RESERVED_NAMES.test(slug) ? `${slug}_` : slug;
}

/**
 * Sanitises a candidate on-disk *file* name (as opposed to {@link slugify},
 * which sanitises a display name into a directory/base segment): illegal
 * characters become `_`, whitespace collapses, but unlike `slugify` a
 * hyphen or a run of internal dots is left untouched, since file names
 * legitimately contain both (`get-weather.xsd`). Never empty.
 */
export function sanitiseFileName(name: string): string {
  const cleaned = name.replace(/\s+/g, ' ').trim().replace(ILLEGAL_CHARS, '_');
  return cleaned === '' ? 'document' : cleaned;
}

/**
 * True when `name` (a full file name, extension included) is a Windows
 * reserved device name — `CON`, `NUL`, `COM1`, ... — with or without an
 * extension.
 */
export function isReservedFileName(name: string): boolean {
  return RESERVED_NAMES.test(name);
}

/**
 * Returns `slugify(name)`, or that slug plus a `-N` suffix when it is already
 * taken. Comparison is case-insensitive because macOS and Windows file systems
 * usually are.
 */
export function uniqueSlug(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name);
  const lower = new Set([...taken].map((s) => s.toLowerCase()));
  if (!lower.has(base.toLowerCase())) {
    return base;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!lower.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

/**
 * Rejects a value that cannot safely be used as a single path segment on disk:
 * empty, `.`/`..`, containing a path separator or NUL, leading/trailing
 * whitespace or dots, or a Windows reserved device name. Used to validate any
 * slug or file reference that flows into a project file path before it is
 * ever written to (or deleted from) disk.
 *
 * @throws ProjectError `project-path-invalid` carrying the offending segment.
 */
export function assertPathSegment(segment: string): void {
  const invalid =
    segment === '' ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\u0000') ||
    /^[. ]/.test(segment) ||
    /[. ]$/.test(segment) ||
    RESERVED_NAMES.test(segment);
  if (invalid) {
    throw new ProjectError('project-path-invalid', `Invalid path segment: ${JSON.stringify(segment)}`, {
      details: { segment },
    });
  }
}

/**
 * Validates a `WssRef.file` value: it must be a relative path (no leading
 * slash or drive letter), rooted at {@link WSS_DIR}, whose every segment
 * passes {@link assertPathSegment} — so it can never resolve outside
 * `wss/` no matter how it was constructed.
 *
 * @throws ProjectError `project-path-invalid` carrying the offending segment.
 */
export function assertWssRelativePath(file: string): void {
  const fail = (segment: string): never => {
    throw new ProjectError('project-path-invalid', `Invalid WSS file reference: ${JSON.stringify(file)}`, {
      details: { segment, file },
    });
  };
  if (
    file === '' ||
    file.includes('\\') ||
    file.includes('\u0000') ||
    file.startsWith('/') ||
    /^[A-Za-z]:/.test(file)
  ) {
    fail(file);
  }
  const segments = file.split('/');
  if (segments[0] !== WSS_DIR || segments.length < 2) {
    fail(file);
  }
  for (const segment of segments.slice(1)) {
    assertPathSegment(segment);
  }
}

/** Directory holding every interface. */
export const INTERFACES_DIR = 'interfaces';
/** Directory holding every environment file. */
export const ENVIRONMENTS_DIR = 'environments';
/** Directory holding WS-Security configurations. */
export const WSS_DIR = 'wss';
/** Per-interface directory holding the cached WSDL/XSD documents (owned by the definition-cache task). */
export const DEFINITION_DIR = 'definition';
/** Per-interface directory holding operation folders. */
export const OPERATIONS_DIR = 'operations';
/** Project-level directory holding cached attachment bytes (owned by the attachments task). */
export const ATTACHMENTS_DIR = 'attachments';
/** Suffix identifying a request metadata file. */
export const REQUEST_SUFFIX = '.request.yaml';
/** Directory holding every REST API, beside `interfaces/`. */
export const APIS_DIR = 'apis';
/** Per-API directory holding the request tree: request files and folder directories. */
export const REQUESTS_DIR = 'requests';
/** File naming a folder inside an API's request tree. */
export const FOLDER_FILE = 'folder.yaml';
/** File describing an API. */
export const API_FILE = 'api.yaml';
/**
 * How deeply folders may nest inside an API's request tree.
 *
 * Eight is not a taste judgement: `apis/<slug>/requests/` plus eight 80-character folder slugs
 * plus a request file already sits close to the 260-character path limit Windows still applies to
 * many APIs, and a tree deeper than this is unreadable in an explorer anyway. A folder below the
 * cap loads as a {@link ProjectProblem} rather than being written to a path that might not open.
 */
export const MAX_FOLDER_DEPTH = 8;

/** Absolute path of the project manifest. */
export function manifestFile(root: string): string {
  return join(root, 'wirebench.yaml');
}

/** Absolute path of an interface's directory. */
export function interfaceDir(root: string, interfaceSlug: string): string {
  return join(root, INTERFACES_DIR, interfaceSlug);
}

/** Absolute path of an interface's metadata file. */
export function interfaceFile(root: string, interfaceSlug: string): string {
  return join(interfaceDir(root, interfaceSlug), 'interface.yaml');
}

/** Absolute path of an interface's definition cache directory (`interfaces/<slug>/definition/`). */
export function definitionDir(root: string, interfaceSlug: string): string {
  return join(interfaceDir(root, interfaceSlug), DEFINITION_DIR);
}

/**
 * Alias of {@link definitionDir} under the name the desktop facade (Task 21)
 * calls it by: the directory passed as `cache.dir` to `importDefinition`.
 */
export const definitionCacheDir = definitionDir;

/** Absolute path of an operation's directory. */
export function operationDir(root: string, interfaceSlug: string, operationSlug: string): string {
  return join(interfaceDir(root, interfaceSlug), OPERATIONS_DIR, operationSlug);
}

/** The two files a request occupies: its YAML metadata and its verbatim envelope. */
export interface RequestFilePair {
  readonly yaml: string;
  readonly xml: string;
}

/** Absolute paths of a request's YAML and XML files. */
export function requestFiles(
  root: string,
  interfaceSlug: string,
  operationSlug: string,
  requestSlug: string,
): RequestFilePair {
  const dir = operationDir(root, interfaceSlug, operationSlug);
  return {
    yaml: join(dir, `${requestSlug}${REQUEST_SUFFIX}`),
    xml: join(dir, `${requestSlug}.xml`),
  };
}

/** Absolute path of an API's directory (`apis/<slug>/`). */
export function apiDir(root: string, apiSlug: string): string {
  return join(root, APIS_DIR, apiSlug);
}

/** Absolute path of an API's metadata file. */
export function apiFile(root: string, apiSlug: string): string {
  return join(apiDir(root, apiSlug), API_FILE);
}

/** Absolute path of an API's definition cache directory (`apis/<slug>/definition/`). */
export function apiDefinitionDir(root: string, apiSlug: string): string {
  return join(apiDir(root, apiSlug), DEFINITION_DIR);
}

/**
 * Absolute path of a directory inside an API's request tree: `apis/<slug>/requests/` itself when
 * `folderSlugs` is empty, and one directory per folder below it otherwise.
 */
export function restFolderDir(root: string, apiSlug: string, folderSlugs: readonly string[] = []): string {
  return join(apiDir(root, apiSlug), REQUESTS_DIR, ...folderSlugs);
}

/** Absolute path of the `folder.yaml` describing the folder at `folderSlugs`. */
export function restFolderFile(root: string, apiSlug: string, folderSlugs: readonly string[]): string {
  return join(restFolderDir(root, apiSlug, folderSlugs), FOLDER_FILE);
}

/** Absolute path of a REST request's metadata file. */
export function restRequestFile(
  root: string,
  apiSlug: string,
  folderSlugs: readonly string[],
  requestSlug: string,
): string {
  return join(restFolderDir(root, apiSlug, folderSlugs), `${requestSlug}${REQUEST_SUFFIX}`);
}

/**
 * The file name a raw body is stored under, beside its request file: `<slug>.body.<ext>`, the
 * extension chosen by the body's language so the file diffs and highlights as what it is.
 */
export function restBodyFileName(requestSlug: string, extension: string): string {
  return `${requestSlug}.body.${extension}`;
}

/** Absolute path of an environment file. */
export function environmentFile(root: string, environmentSlug: string): string {
  return join(root, ENVIRONMENTS_DIR, `${environmentSlug}.yaml`);
}

/** Absolute path of a WS-Security configuration file. */
export function wssFile(root: string, direction: 'outgoing' | 'incoming', name: string): string {
  return join(root, WSS_DIR, direction, `${name}.yaml`);
}

/** Absolute path of the keystore registry file. */
export function keystoresFile(root: string): string {
  return join(root, WSS_DIR, 'keystores.yaml');
}
