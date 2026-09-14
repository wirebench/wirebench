/**
 * Client-side mirrors of main's `assertRemoteUrl` and `assertBranchName`
 * (`apps/desktop/src/main/sync/git-cli.ts`), for inline feedback in the Share and Join dialogs
 * only — main still validates and is the actual authority. Never echoes the checked value back
 * in a message: a bad remote or branch name could itself carry something the user should not
 * see repeated at them.
 *
 * Pure and store-free so it can be unit-tested without mounting anything.
 */

export interface ValidationResult {
  readonly valid: boolean;
  /** Set only when `valid` is `false`. */
  readonly message?: string;
}

const VALID: ValidationResult = { valid: true };

function invalid(message: string): ValidationResult {
  return { valid: false, message };
}

/**
 * `user@host:path` remotes (the scp-like syntax `assertRemoteUrl` accepts alongside URL
 * schemes), captured so the user/host parts can be checked for a leading `-` individually.
 */
const SCP_LIKE_REMOTE = /^([\w.-]+)@([\w.-]+):([^\s]+)$/;

/** A literal `scheme://` prefix — deliberately not matching a scheme-only form like `https:x`. */
const SCHEME_PREFIX = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;

/** Schemes accepted (compared case-insensitively). */
const ALLOWED_SCHEMES = ['https:', 'ssh:', 'file:'];

/** Any whitespace or C0/DEL control character. */
const WHITESPACE_OR_CONTROL = /[\s\x00-\x1f\x7f]/;

/**
 * Mirrors `assertRemoteUrl`: refuses anything that is not a literal `https://`, `ssh://` or
 * `file://` URL (scheme case-insensitive) or a `user@host:path` remote. An empty string is
 * valid here — the remote is optional in the Share dialog (an empty remote just shares to a
 * local git repository with no `origin`) — callers that require one check emptiness themselves.
 */
export function validateRemoteUrl(url: string): ValidationResult {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return VALID;
  }
  if (WHITESPACE_OR_CONTROL.test(trimmed) || trimmed.startsWith('-')) {
    return invalid('This remote URL is not allowed.');
  }
  if (trimmed.toLowerCase().startsWith('ext::')) {
    return invalid('This remote URL is not allowed.');
  }

  const componentInvalid = (raw: string): boolean => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return true;
    }
    return decoded.startsWith('-') || WHITESPACE_OR_CONTROL.test(decoded);
  };

  const scpMatch = SCP_LIKE_REMOTE.exec(trimmed);
  if (scpMatch !== null) {
    const [, user, host] = scpMatch;
    if (componentInvalid(user!) || componentInvalid(host!)) {
      return invalid('This remote URL is not allowed.');
    }
    return VALID;
  }

  const schemeMatch = SCHEME_PREFIX.exec(trimmed);
  if (schemeMatch === null || !ALLOWED_SCHEMES.includes(`${schemeMatch[1]!.toLowerCase()}:`)) {
    return invalid('Use https://, ssh://, file:// or user@host:path.');
  }

  try {
    const parsed = new URL(trimmed);
    if (componentInvalid(parsed.username) || componentInvalid(parsed.hostname)) {
      return invalid('This remote URL is not allowed.');
    }
  } catch {
    return invalid('Use https://, ssh://, file:// or user@host:path.');
  }

  return VALID;
}

/** Any character `assertBranchName` refuses outright, wherever it appears in the name. */
const BRANCH_FORBIDDEN_CHARS = /[\s\x00-\x1f\x7f~^:?*[\\]/;

/**
 * Mirrors `assertBranchName`: refuses empty, a leading `-`, whitespace/control characters,
 * `..`, `@{`, `\`, any of `~^:?*[`, a leading or trailing `/`, `//`, a trailing `.lock`, a
 * trailing `.`, a component starting with `.`, and the bare name `@`.
 */
export function validateBranchName(name: string): ValidationResult {
  if (
    name.length === 0 ||
    name.startsWith('-') ||
    BRANCH_FORBIDDEN_CHARS.test(name) ||
    name.includes('..') ||
    name.includes('@{') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.includes('//') ||
    name.endsWith('.lock') ||
    name.endsWith('.') ||
    name === '@' ||
    name.split('/').some((part) => part.startsWith('.'))
  ) {
    return invalid('This branch name is not allowed.');
  }
  return VALID;
}
