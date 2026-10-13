/**
 * Schedule secrets and alert URLs at rest (scheduled-runs spec §3.3, §3.4): sealed under the schedules
 * key with the webhook-signatures box, stored base64, and never handed back. A read gets a hint.
 */
import type { AlertTarget, AlertTargetInput, ScheduleSecrets } from '@wirebench/engine';
import { hintOf, open, seal } from '../hooks/secret-box.js';
import { alertHostRefused, secretKeyMissing, smtpMissing } from './errors.js';
import { alertHostAllowed, type SchedulesSettings } from './settings.js';

/** One sealed value: the box in base64 and the hint a read shows. */
export interface SealedValue {
  readonly sealed: string;
  readonly hint: string | null;
}

/** An alert target as stored: an email target as given, a URL sealed beside its host and hint. */
export type StoredAlertTarget =
  | { readonly kind: 'email'; readonly to: readonly string[] }
  | { readonly kind: 'slack' | 'teams'; readonly url: SealedValue; readonly host: string }
  | { readonly kind: 'webhook'; readonly url: SealedValue; readonly host: string; readonly secret?: SealedValue };

export interface StoredAlerts {
  readonly targets: readonly StoredAlertTarget[];
  readonly muteAfter: number;
}

/** Name → sealed value. */
export type StoredSecrets = Readonly<Record<string, SealedValue>>;

function keyOf(settings: Pick<SchedulesSettings, 'secretKey'>): Buffer {
  if (settings.secretKey === undefined) {
    throw secretKeyMissing();
  }
  return settings.secretKey;
}

export function sealValue(key: Buffer, value: string): SealedValue {
  return { sealed: seal(key, value).toString('base64'), hint: hintOf(value) };
}

export function openValue(key: Buffer, value: SealedValue): string {
  return open(key, Buffer.from(value.sealed, 'base64'));
}

/**
 * The targets as stored, checked against the server's settings.
 *
 * @throws `schedules-smtp-missing` for an email target without mail settings,
 *   `schedules-alert-host-refused` for a URL off the allow-list,
 *   `schedules-secret-key-missing` for a URL target without the schedules key
 */
export function sealAlertTargets(
  settings: Pick<SchedulesSettings, 'secretKey' | 'alertHosts' | 'smtp'>,
  targets: readonly AlertTargetInput[],
): StoredAlertTarget[] {
  return targets.map((target) => {
    if (target.kind === 'email') {
      if (settings.smtp === undefined) {
        throw smtpMissing();
      }
      return { kind: 'email', to: [...target.to] };
    }
    const host = new URL(target.url).hostname.toLowerCase();
    if (!alertHostAllowed(settings, host)) {
      throw alertHostRefused(host);
    }
    const key = keyOf(settings);
    const url = sealValue(key, target.url);
    if (target.kind === 'webhook') {
      return {
        kind: 'webhook',
        url,
        host,
        ...(target.secret !== undefined ? { secret: sealValue(key, target.secret) } : {}),
      };
    }
    return { kind: target.kind, url, host };
  });
}

/** What a read shows of a stored target: never the URL or the webhook secret. */
export function alertTargetView(target: StoredAlertTarget): AlertTarget {
  switch (target.kind) {
    case 'email':
      return { kind: 'email', to: [...target.to] };
    case 'webhook':
      return { kind: 'webhook', host: target.host, hint: target.url.hint ?? '', signed: target.secret !== undefined };
    default:
      return { kind: target.kind, host: target.host, hint: target.url.hint ?? '' };
  }
}

/** The secrets after a `PUT …/secrets`, and which names it added, changed and removed. */
export function mergeSecrets(
  settings: Pick<SchedulesSettings, 'secretKey'>,
  stored: StoredSecrets,
  input: ScheduleSecrets,
): { secrets: Record<string, SealedValue>; added: string[]; changed: string[]; removed: string[] } {
  const secrets: Record<string, SealedValue> = { ...stored };
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const names = Object.keys(input).sort();
  const key = names.some((name) => input[name] !== null) ? keyOf(settings) : undefined;
  for (const name of names) {
    const value = input[name];
    if (value === null || value === undefined) {
      if (name in secrets) {
        delete secrets[name];
        removed.push(name);
      }
    } else {
      (name in secrets ? changed : added).push(name);
      secrets[name] = sealValue(key!, value);
    }
  }
  return { secrets, added, changed, removed };
}

/** Each secret's name and hint, by name. */
export function secretSummaries(stored: StoredSecrets): { name: string; hint: string | null }[] {
  return Object.keys(stored)
    .sort()
    .map((name) => ({ name, hint: stored[name]!.hint }));
}

/** Every secret's value, for a run. @throws `schedules-secret-key-missing` when there are any and no key. */
export function openSecrets(
  settings: Pick<SchedulesSettings, 'secretKey'>,
  stored: StoredSecrets,
): Record<string, string> {
  const names = Object.keys(stored);
  if (names.length === 0) {
    return {};
  }
  const key = keyOf(settings);
  return Object.fromEntries(names.map((name) => [name, openValue(key, stored[name]!)]));
}
