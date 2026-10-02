/**
 * Between a prepared send and the script API (spec §What a pre-request script can change, §Secrets).
 *
 * A request with scripts is prepared with every `${secret:…}` in its text replaced by an
 * unguessable placeholder, so a script sees neither the value nor text it could turn into a
 * reference. After the script, the host puts each placeholder back as the secret's value — secrets
 * are substituted raw by every expander, so the value lands exactly as it would have. A placeholder
 * is alphanumeric, so no escaping along the way changes it, and a value a server chose can never
 * name one: the nonce is new for every send.
 *
 * Each protocol's converters between a prepared send and the snapshot a script sees live in its
 * own folder (`<protocol>/scripting.ts`); the helpers at the end of this file are what they share.
 */
import { randomUUID } from 'node:crypto';
import type { KeyValueEntry } from '../http/entries.js';
import { resolveSecretTokens, type GetSecret } from '../secrets/resolve.js';
import type { HeaderPair } from './model.js';

/** The placeholders one send's secrets stand behind until its pre-request script has run. */
export class SecretPlaceholders {
  private readonly nonce = randomUUID().replace(/-/g, '');
  private readonly byName = new Map<string, string>();

  /** The placeholder for `name`, the same one every time within this send. */
  placeholderFor(name: string): string {
    let placeholder = this.byName.get(name);
    if (placeholder === undefined) {
      placeholder = `wbsec${this.nonce}n${String(this.byName.size)}z`;
      this.byName.set(name, placeholder);
    }
    return placeholder;
  }

  /** A `secrets` scope that maps each name to its placeholder, for the given names. */
  scopeFor(names: Iterable<string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of names) out[name] = this.placeholderFor(name);
    return out;
  }

  get size(): number {
    return this.byName.size;
  }

  /** True when `text` holds one of this send's placeholders: a secret whose value is not in yet. */
  holds(text: string): boolean {
    for (const placeholder of this.byName.values()) {
      if (text.includes(placeholder)) return true;
    }
    return false;
  }

  /**
   * `value` with every placeholder replaced by its secret's value, in every string it holds.
   *
   * @throws WirebenchError `secret-missing` when a secret cannot be read
   */
  async restore<T>(value: T, getSecret: GetSecret): Promise<T> {
    if (this.byName.size === 0) return value;
    const secrets = await resolveSecretTokens(this.byName.keys(), getSecret);
    const replacements = new Map([...this.byName].map(([name, placeholder]) => [placeholder, secrets[name] ?? '']));
    const pattern = new RegExp([...replacements.keys()].join('|'), 'g');
    const walk = (node: unknown): unknown => {
      if (typeof node === 'string') return node.replace(pattern, (hit) => replacements.get(hit) ?? hit);
      if (Array.isArray(node)) return node.map(walk);
      if (node !== null && typeof node === 'object') {
        return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
      }
      return node;
    };
    return walk(value) as T;
  }
}

/** The enabled rows of a key-value table as header pairs, in order. */
export const pairsOf = (entries: readonly KeyValueEntry[]): HeaderPair[] =>
  entries.filter((e) => e.enabled).map((e) => [e.name, e.value] as const);

/** Header pairs as enabled key-value rows. */
export const entriesOf = (pairs: readonly HeaderPair[]): KeyValueEntry[] =>
  pairs.map(([name, value]) => ({ name, value, enabled: true }));

/** A record's entries as header pairs. */
export const recordPairs = (record: Readonly<Record<string, string>> | undefined): HeaderPair[] =>
  Object.entries(record ?? {}).map(([name, value]) => [name, value] as const);
