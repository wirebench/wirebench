/**
 * Detection rules for the secret scanner (docs/specs/2026-09-22-secret-scanning-design.md §7):
 * a value under a sensitive name, and credential shapes that are recognisable anywhere. Every match
 * is the credential part only (`Bearer eyJ…` matches `eyJ…`), so replacing `[start, end)` with a
 * `${secret:name}` token leaves the rest of the text as it was. A match that touches a `${…}`
 * expansion is dropped: that value is already a reference, not a secret.
 *
 * Pure module: no I/O.
 */
import { isSensitiveHeaderName, isSensitiveQueryParam, SECRET_BODY_KEYS } from '../../redact/index.js';

export type SecretRule =
  'sensitive-name' | 'jwt' | 'bearer' | 'basic' | 'aws-key' | 'private-key' | 'vendor-token' | 'high-entropy';

/** One detected credential: its rule and its `[start, end)` range in the scanned text. */
export interface SecretMatch {
  readonly rule: SecretRule;
  readonly start: number;
  readonly end: number;
}

export interface DetectContext {
  /** The body's content type; `application/x-www-form-urlencoded` turns on form-pair detection. */
  readonly contentType?: string;
  /**
   * The name the text is stored under (a header, query parameter, form field or property). When
   * given, the text is one value: a non-empty value under a sensitive name is a finding as a whole.
   */
  readonly fieldName?: string;
  /** Which name list {@link fieldName} is checked against; every list when absent. */
  readonly nameKind?: 'header' | 'query' | 'field' | 'property';
}

/** Text beyond this many characters is not scanned (spec: bodies over 1 MiB, first 1 MiB only). */
export const SECRET_TEXT_SCAN_LIMIT = 1024 * 1024;

const BODY_KEY_SET = new Set(SECRET_BODY_KEYS);
/** Name parts that make a name credential-like on their own (`dbPassword`, `client_secret`). */
const CREDENTIAL_PARTS = new Set(['secret', 'token', 'password', 'passwd', 'credential', 'credentials']);
/** Parts that make a following `key` credential-like (`apiKey`, `secret_key`); `cacheKey` is not. */
const KEY_QUALIFIERS = new Set(['api', 'secret', 'access', 'private', 'signing', 'client', 'auth', 'master']);
const HIGH_ENTROPY_MIN_LENGTH = 20;
const HIGH_ENTROPY_MIN_BITS = 3.5;

/** When two matches overlap, the one whose rule comes first here wins. */
const RULE_PRIORITY: readonly SecretRule[] = [
  'private-key',
  'jwt',
  'vendor-token',
  'aws-key',
  'bearer',
  'basic',
  'sensitive-name',
  'high-entropy',
];

const PEM_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
const JWT_RE = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const VENDOR_RE =
  /(?<![A-Za-z0-9_])(?:gh[pos]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})/g;
const AWS_RE = /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g;
const BEARER_RE = /\bBearer[ \t]+([A-Za-z0-9._~+/-]+=*)/g;
const BASIC_RE = /\bBasic[ \t]+([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/g;
/** A scheme prefix on a sensitive header's value, left in place when the credential is replaced. */
const SCHEME_PREFIX_RE = /^(?:Bearer|Basic|Token|Digest|Negotiate|NTLM)[ \t]+/i;

const JSON_PAIR_RE = /"((?:[^"\\\n]|\\.){1,128})"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const XML_ELEMENT_RE = /<((?:[\w.-]+:)?([\w.-]+))((?:\s[^<>]*)?)>([^<]*)<\/\1>/g;
const FORM_PAIR_RE = /(?:^|[&?])([^=&?#]+)=([^&#]*)/g;

/** Shannon entropy of `text`, in bits per character. */
export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** `[start, end)` of every `${…}` expansion in `text`, nested braces included. */
function expansionRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let from = 0;
  for (;;) {
    const open = text.indexOf('${', from);
    if (open < 0) return ranges;
    let depth = 0;
    let end = -1;
    for (let i = open + 1; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 123 /* { */) depth++;
      else if (ch === 125 /* } */ && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end < 0) return ranges;
    ranges.push([open, end]);
    from = end;
  }
}

/** `dbPassword`, `api_key`, `X-Client-Secret` → lower-case word parts. */
function nameParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part !== '');
}

/** True when a word part of `name` says it holds a credential. */
function isCredentialLikeName(name: string): boolean {
  const parts = nameParts(name);
  return parts.some(
    (part, i) => CREDENTIAL_PARTS.has(part) || (part === 'key' && i > 0 && KEY_QUALIFIERS.has(parts[i - 1]!)),
  );
}

function isSensitiveName(name: string, kind: DetectContext['nameKind']): boolean {
  const lower = name.trim().toLowerCase();
  if (kind === 'property') return BODY_KEY_SET.has(lower) || isCredentialLikeName(name);
  if (kind === 'header') return isSensitiveHeaderName(lower) || BODY_KEY_SET.has(lower);
  if (kind === 'query') return isSensitiveQueryParam(lower) || BODY_KEY_SET.has(lower);
  if (kind === 'field') return BODY_KEY_SET.has(lower);
  return isSensitiveHeaderName(lower) || isSensitiveQueryParam(lower) || BODY_KEY_SET.has(lower);
}

function basicLooksReal(encoded: string): boolean {
  try {
    return Buffer.from(encoded, 'base64').toString('latin1').includes(':');
  } catch {
    return false;
  }
}

function pushAll(out: SecretMatch[], re: RegExp, text: string, rule: SecretRule, group?: number): void {
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (group === undefined) {
      out.push({ rule, start: m.index, end: m.index + m[0].length });
      continue;
    }
    const part = m[group]!;
    const start = m.index + m[0].length - part.length;
    // A token-shaped run of 16+ characters; words joined by `/` ("Bearer tokens/credentials") are prose.
    if (rule === 'bearer' && (part.length < 16 || /^[A-Za-z]+(?:\/[A-Za-z]+)+$/.test(part))) continue;
    if (rule === 'basic' && !basicLooksReal(part)) continue;
    out.push({ rule, start, end: start + part.length });
  }
}

function shapeMatches(text: string): SecretMatch[] {
  const out: SecretMatch[] = [];
  if (text.includes('-----BEGIN')) pushAll(out, PEM_RE, text, 'private-key');
  if (text.includes('eyJ')) pushAll(out, JWT_RE, text, 'jwt');
  if (text.includes('gh') || text.includes('github_pat_') || text.includes('xox'))
    pushAll(out, VENDOR_RE, text, 'vendor-token');
  if (text.includes('AKIA') || text.includes('ASIA')) pushAll(out, AWS_RE, text, 'aws-key');
  if (text.includes('Bearer')) pushAll(out, BEARER_RE, text, 'bearer', 1);
  if (text.includes('Basic')) pushAll(out, BASIC_RE, text, 'basic', 1);
  return out;
}

/**
 * The name-based match for one value stored under `name`, offset by `offset` in the scanned text:
 * `sensitive-name` for a listed name (whatever the value looks like), else `high-entropy` for a
 * long, random-looking value under a name that merely sounds secret.
 */
function nameMatch(
  value: string,
  offset: number,
  name: string,
  kind: DetectContext['nameKind'],
): SecretMatch | undefined {
  let start = 0;
  let end = value.length;
  while (start < end && /\s/.test(value[start]!)) start++;
  while (end > start && /\s/.test(value[end - 1]!)) end--;
  const scheme = SCHEME_PREFIX_RE.exec(value.slice(start, end));
  if (scheme !== null && kind !== 'field' && kind !== 'property') start += scheme[0].length;
  if (start >= end) return undefined;
  if (isSensitiveName(name, kind)) return { rule: 'sensitive-name', start: offset + start, end: offset + end };
  const core = value.slice(start, end);
  if (
    isCredentialLikeName(name) &&
    !/\s/.test(core) &&
    !/^(?:[a-z][a-z0-9+.-]*:\/\/|[~.]?[/\\]|[A-Za-z]:[/\\])/i.test(core) &&
    core.length >= HIGH_ENTROPY_MIN_LENGTH &&
    shannonEntropy(core) >= HIGH_ENTROPY_MIN_BITS
  ) {
    return { rule: 'high-entropy', start: offset + start, end: offset + end };
  }
  return undefined;
}

function isFormType(contentType: string | undefined): boolean {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

function structuredMatches(
  text: string,
  contentType: string | undefined,
  formNames: DetectContext['nameKind'],
): SecretMatch[] {
  const out: SecretMatch[] = [];
  const add = (m: SecretMatch | undefined): void => {
    if (m !== undefined) out.push(m);
  };
  if (text.includes('":')) {
    JSON_PAIR_RE.lastIndex = 0;
    for (let m = JSON_PAIR_RE.exec(text); m !== null; m = JSON_PAIR_RE.exec(text)) {
      const value = m[2]!;
      add(nameMatch(value, m.index + m[0].length - 1 - value.length, m[1]!, 'field'));
    }
  }
  if (text.includes('</')) {
    XML_ELEMENT_RE.lastIndex = 0;
    for (let m = XML_ELEMENT_RE.exec(text); m !== null; m = XML_ELEMENT_RE.exec(text)) {
      // A WS-Security digest is a hash of the password, not the password; redaction keeps it too.
      if (/PasswordDigest/.test(m[3]!)) continue;
      const value = m[4]!;
      const closeLength = m[1]!.length + 3;
      add(nameMatch(value, m.index + m[0].length - closeLength - value.length, m[2]!, 'field'));
    }
  }
  if (isFormType(contentType)) {
    FORM_PAIR_RE.lastIndex = 0;
    for (let m = FORM_PAIR_RE.exec(text); m !== null; m = FORM_PAIR_RE.exec(text)) {
      let key = m[1]!;
      try {
        key = decodeURIComponent(key.replace(/\+/g, ' '));
      } catch {
        // keep the raw key
      }
      const value = m[2]!;
      add(nameMatch(value, m.index + m[0].length - value.length, key, formNames));
    }
  }
  return out;
}

/** Drops matches inside or across an expansion, then overlaps, keeping the higher-priority rule. */
function settle(matches: SecretMatch[], text: string): SecretMatch[] {
  if (matches.length === 0) return matches;
  const expansions = text.includes('${') ? expansionRanges(text) : [];
  const live = matches.filter((m) => m.end > m.start && !expansions.some(([s, e]) => m.start < e && s < m.end));
  live.sort(
    (a, b) => a.start - b.start || RULE_PRIORITY.indexOf(a.rule) - RULE_PRIORITY.indexOf(b.rule) || b.end - a.end,
  );
  const kept: SecretMatch[] = [];
  for (const m of live) {
    const clash = kept.findIndex((k) => m.start < k.end && k.start < m.end);
    if (clash < 0) {
      kept.push(m);
    } else if (RULE_PRIORITY.indexOf(m.rule) < RULE_PRIORITY.indexOf(kept[clash]!.rule)) {
      kept[clash] = m;
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * Every credential in `text`. With `context.fieldName` the text is one stored value (a header, a
 * query parameter, a form field, a property); without it, a body, where JSON keys, form fields and
 * XML element local names in `SECRET_BODY_KEYS` count as sensitive names. Only the first
 * {@link SECRET_TEXT_SCAN_LIMIT} characters are scanned.
 */
export function detectInText(text: string, context: DetectContext = {}): SecretMatch[] {
  const scanned = text.length > SECRET_TEXT_SCAN_LIMIT ? text.slice(0, SECRET_TEXT_SCAN_LIMIT) : text;
  if (scanned.length === 0) return [];
  const matches = shapeMatches(scanned);
  if (context.fieldName !== undefined) {
    const named = nameMatch(scanned, 0, context.fieldName, context.nameKind);
    if (named !== undefined && matches.length === 0) matches.push(named);
  } else {
    matches.push(...structuredMatches(scanned, context.contentType, context.nameKind ?? 'field'));
  }
  return settle(matches, scanned);
}
