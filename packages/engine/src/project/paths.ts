/**
 * File-system naming and layout for a project folder.
 *
 * Display names live inside the YAML; the folder/file names are `slugify(name)`
 * so a project stays readable and diffable in git while remaining portable
 * across Windows, macOS and Linux.
 */

import { join } from 'node:path';

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

/** Absolute path of the (task-18-owned) definition cache directory of an interface. */
export function definitionDir(root: string, interfaceSlug: string): string {
  return join(interfaceDir(root, interfaceSlug), DEFINITION_DIR);
}

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
