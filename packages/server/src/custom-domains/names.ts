/**
 * Custom names (hosted edition spec §23.1): which names a tenant may claim, and the two DNS records that prove one.
 * Pure: no DNS, no database. The server carries no public suffix list, so an apex passes here and simply never passes
 * the check, since an apex cannot hold a CNAME.
 */
import { isDomainName } from '../config.js';

/** The label every custom name's CNAME points at, under the app domain. Reserved as a slug (`tenancy/slugs.ts`). */
export const CUSTOM_TARGET_LABEL = 'custom';

/** The label under a custom name that holds its TXT token. */
export const TXT_LABEL = '_wirebench';

/** What the TXT record's one string must equal, before the token. */
export const TXT_PREFIX = 'wirebench-domain-verification=';

export type CustomNameReason = 'custom-name-invalid' | 'custom-name-ours' | 'custom-name-local';

export type CustomNameCheck =
  { readonly ok: true; readonly name: string } | { readonly ok: false; readonly reason: CustomNameReason };

export interface CustomNameConfig {
  readonly appDomain: string;
  readonly siteDomain: string;
  /** Tests only: lets a name under `.test` through, as every test name is. */
  readonly allowTest?: boolean;
}

/** Suffixes that never resolve on the public internet (RFC 6761, RFC 6762, and ICANN's `.internal`). */
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'test', 'example', 'invalid'] as const;

function isUnder(name: string, domain: string): boolean {
  return name === domain || name.endsWith(`.${domain}`);
}

/** Whether `input` may be claimed: the shape of §21.1 with no `*`, not ours, not local. Lower-cases it first. */
export function checkCustomName(input: string, config: CustomNameConfig): CustomNameCheck {
  const name = input.trim().toLowerCase();
  if (name === 'localhost') return { ok: false, reason: 'custom-name-local' };
  if (!isDomainName(name)) return { ok: false, reason: 'custom-name-invalid' };
  if (isUnder(name, config.appDomain.toLowerCase()) || isUnder(name, config.siteDomain.toLowerCase())) {
    return { ok: false, reason: 'custom-name-ours' };
  }
  const local = LOCAL_SUFFIXES.filter((suffix) => !(suffix === 'test' && config.allowTest === true));
  if (local.some((suffix) => isUnder(name, suffix))) return { ok: false, reason: 'custom-name-local' };
  return { ok: true, name };
}

export interface DnsRecord {
  readonly type: 'CNAME' | 'TXT';
  readonly name: string;
  readonly value: string;
}

/** The CNAME target every custom name points at. */
export function customTarget(appDomain: string): string {
  return `${CUSTOM_TARGET_LABEL}.${appDomain.toLowerCase()}`;
}

/** The two records the tenant creates for `name`, in the order the Settings tab shows them. */
export function recordsFor(name: string, token: string, appDomain: string): readonly DnsRecord[] {
  return [
    { type: 'CNAME', name, value: customTarget(appDomain) },
    { type: 'TXT', name: `${TXT_LABEL}.${name}`, value: `${TXT_PREFIX}${token}` },
  ];
}
