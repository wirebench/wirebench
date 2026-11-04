/**
 * The DNS check of a custom name (hosted edition spec §23.2): its CNAME points at `custom.<app-domain>` (or, where a
 * provider flattens CNAMEs, its A and AAAA answers equal that name's), and one TXT string at `_wirebench.<name>`
 * equals the claim's value. Every query goes through a {@link DnsLookup}, so a test passes a fake and no test asks
 * real DNS. {@link verifyRecords} never throws: a timeout or a server failure is a message, and the record reads as
 * missing. No message carries the token.
 */
import { Resolver } from 'node:dns/promises';
import { customTarget, TXT_LABEL, TXT_PREFIX } from './names.js';

/** The four queries the check makes. A name with no such record rejects with `ENOTFOUND` or `ENODATA`. */
export interface DnsLookup {
  cname(name: string): Promise<readonly string[]>;
  a(name: string): Promise<readonly string[]>;
  aaaa(name: string): Promise<readonly string[]>;
  /** Each record's strings, as `resolveTxt` returns them: a long value comes split into chunks. */
  txt(name: string): Promise<readonly (readonly string[])[]>;
}

/** How long one query waits, and how many times it is sent (spec §23.2). */
export const DNS_TIMEOUT_MS = 5_000;
export const DNS_TRIES = 2;

/**
 * Lookups through `node:dns/promises`' `Resolver`: the `WIREBENCH_SERVER_DNS_SERVERS` servers when given (IP
 * addresses, each with an optional port, as `Resolver.setServers` takes them), otherwise the system's.
 *
 * @throws when a server is not an IP address with an optional port (the config refuses one first).
 */
export function systemLookup(servers?: readonly string[]): DnsLookup {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES });
  if (servers !== undefined && servers.length > 0) resolver.setServers([...servers]);
  return {
    cname: (name) => resolver.resolveCname(name),
    a: (name) => resolver.resolve4(name),
    aaaa: (name) => resolver.resolve6(name),
    txt: (name) => resolver.resolveTxt(name),
  };
}

/** One record's verdict, as `last_result` stores it (spec §23.3). */
export type RecordVerdict = 'ok' | 'missing' | 'wrong';

export interface RecordsResult {
  readonly cname: RecordVerdict;
  readonly txt: RecordVerdict;
  /** In words, for the Settings tab and the admin command. Never the token. */
  readonly message: string;
}

type Answer<T> =
  | { readonly kind: 'found'; readonly values: readonly T[] }
  | { readonly kind: 'none' }
  | { readonly kind: 'failed'; readonly why: string };

/** No such record, as `node:dns` says it. */
const ABSENT = new Set(['ENOTFOUND', 'ENODATA']);

async function ask<T>(query: () => Promise<readonly T[]>): Promise<Answer<T>> {
  try {
    const values = await query();
    return values.length === 0 ? { kind: 'none' } : { kind: 'found', values };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && ABSENT.has(code)) return { kind: 'none' };
    if (code === 'ETIMEOUT') return { kind: 'failed', why: 'timed out' };
    return { kind: 'failed', why: typeof code === 'string' ? `failed (${code})` : 'failed' };
  }
}

const bare = (name: string): string => name.toLowerCase().replace(/\.$/, '');

/** The addresses of one answer, lower-cased and sorted; an absent record is the empty set. */
function addresses(answer: Answer<string>): readonly string[] | undefined {
  if (answer.kind === 'failed') return undefined;
  return answer.kind === 'none' ? [] : [...new Set(answer.values.map((value) => value.toLowerCase()))].sort();
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

async function checkCname(
  lookup: DnsLookup,
  name: string,
  target: string,
): Promise<{ verdict: RecordVerdict; message: string }> {
  const cname = await ask(() => lookup.cname(name));
  if (cname.kind === 'found') {
    const values = cname.values.map(bare);
    if (values.includes(target)) return { verdict: 'ok', message: `The CNAME at ${name} points to ${target}.` };
    return { verdict: 'wrong', message: `The CNAME at ${name} points to ${values[0]!}, not ${target}.` };
  }
  if (cname.kind === 'failed') {
    return { verdict: 'missing', message: `The CNAME lookup for ${name} ${cname.why}.` };
  }
  // No CNAME: a provider that flattens it answers with the target's own addresses instead.
  const [nameA, nameAaaa, targetA, targetAaaa] = await Promise.all([
    ask(() => lookup.a(name)),
    ask(() => lookup.aaaa(name)),
    ask(() => lookup.a(target)),
    ask(() => lookup.aaaa(target)),
  ]);
  const failed = [nameA, nameAaaa, targetA, targetAaaa].find((answer) => answer.kind === 'failed');
  if (failed?.kind === 'failed') {
    return { verdict: 'missing', message: `The address lookup for ${name} or ${target} ${failed.why}.` };
  }
  const mine = { a: addresses(nameA)!, aaaa: addresses(nameAaaa)! };
  const theirs = { a: addresses(targetA)!, aaaa: addresses(targetAaaa)! };
  if (mine.a.length + mine.aaaa.length === 0) {
    return { verdict: 'missing', message: `There is no CNAME at ${name}: it should point to ${target}.` };
  }
  if (theirs.a.length + theirs.aaaa.length > 0 && same(mine.a, theirs.a) && same(mine.aaaa, theirs.aaaa)) {
    return { verdict: 'ok', message: `${name} answers with ${target}'s addresses (a flattened CNAME).` };
  }
  return {
    verdict: 'wrong',
    message: `${name} has no CNAME, and its addresses are not ${target}'s: point a CNAME at ${target}.`,
  };
}

async function checkTxt(
  lookup: DnsLookup,
  txtName: string,
  token: string,
): Promise<{ verdict: RecordVerdict; message: string }> {
  const txt = await ask(() => lookup.txt(txtName));
  if (txt.kind === 'failed') return { verdict: 'missing', message: `The TXT lookup for ${txtName} ${txt.why}.` };
  if (txt.kind === 'none') return { verdict: 'missing', message: `There is no TXT record at ${txtName}.` };
  const expected = `${TXT_PREFIX}${token}`;
  if (txt.values.some((chunks) => chunks.join('') === expected)) {
    return { verdict: 'ok', message: `The TXT record at ${txtName} holds this claim's token.` };
  }
  return { verdict: 'wrong', message: `No TXT record at ${txtName} holds this claim's token.` };
}

/** Checks both records of `name`'s claim through `lookup`. Never throws; the message never carries the token. */
export async function verifyRecords(
  lookup: DnsLookup,
  name: string,
  token: string,
  appDomain: string,
): Promise<RecordsResult> {
  const host = bare(name);
  const [cname, txt] = await Promise.all([
    checkCname(lookup, host, customTarget(appDomain)),
    checkTxt(lookup, `${TXT_LABEL}.${host}`, token),
  ]);
  return { cname: cname.verdict, txt: txt.verdict, message: `${cname.message} ${txt.message}` };
}
