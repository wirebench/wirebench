/**
 * One namespace/prefix table shared by every fragment of a single envelope.
 *
 * The sample generator declares namespaces on each fragment's own root; an
 * envelope reads much better with every declaration hoisted onto
 * `soapenv:Envelope` instead. Sharing one scope across all fragments is what
 * makes that safe: a namespace gets the same prefix everywhere, so hoisting
 * cannot change any name's meaning.
 */

import { NS } from '../xml/namespaces.js';
import { prefixForNamespace, RESERVED_PREFIXES } from './prefixes.js';

/** Prefixes the envelope pins regardless of what a mnemonic would suggest. */
const PINNED: readonly (readonly [string, string])[] = [
  [NS.XSD, 'xsd'],
  [NS.XSI, 'xsi'],
  [NS.SOAP11_ENC, 'soapenc'],
];

/** Assigns one prefix per namespace URI and records which ones were actually used. */
export class NamespaceScope {
  private readonly byUri = new Map<string, string>();
  private readonly taken = new Set<string>(RESERVED_PREFIXES);
  private readonly used = new Map<string, string>();

  /**
   * @param seedUris namespaces to name up-front, so mnemonics are assigned in a
   *   stable order rather than in whatever order fragments happen to use them
   * @param overrides caller-supplied namespace URI → prefix, which always wins
   */
  constructor(seedUris: readonly string[], overrides: Readonly<Record<string, string>> = {}) {
    const overridden = new Set<string>();
    for (const [uri, prefix] of Object.entries(overrides)) {
      this.byUri.set(uri, prefix);
      this.taken.add(prefix);
      overridden.add(prefix);
    }
    // Pinned prefixes are reserved *for* these namespaces, so `taken` (which
    // holds every reserved prefix) must not block them — only an explicit
    // caller override can.
    for (const [uri, prefix] of PINNED) {
      if (!this.byUri.has(uri) && !overridden.has(prefix)) {
        this.assign(uri, prefix);
      }
    }
    for (const uri of seedUris) {
      if (uri !== '' && !this.byUri.has(uri)) {
        this.assign(uri, prefixForNamespace(uri, this.taken));
      }
    }
  }

  private assign(uri: string, prefix: string): void {
    this.byUri.set(uri, prefix);
    this.taken.add(prefix);
  }

  /** Namespace URI → prefix for every namespace named so far; the generator's `prefixes` map. */
  prefixes(): Record<string, string> {
    return Object.fromEntries(this.byUri);
  }

  /** The prefix for `uri`, allocating one if needed, and marks it as used. The empty namespace has none. */
  use(uri: string): string {
    if (uri === '') {
      return '';
    }
    let prefix = this.byUri.get(uri);
    if (prefix === undefined) {
      prefix = prefixForNamespace(uri, this.taken);
      this.assign(uri, prefix);
    }
    this.used.set(prefix, uri);
    return prefix;
  }

  /** Records the prefix → URI bindings a generated fragment declared on its own root. */
  markUsed(namespaces: Readonly<Record<string, string>>): void {
    for (const [prefix, uri] of Object.entries(namespaces)) {
      this.assign(uri, prefix);
      this.used.set(prefix, uri);
    }
  }

  /** Prefix → URI for every namespace actually used, in first-use order: the envelope's declarations. */
  declarations(): Record<string, string> {
    return Object.fromEntries(this.used);
  }

  /** True when `prefix` is declared on the envelope bound to `uri`. */
  declares(prefix: string, uri: string): boolean {
    return this.used.get(prefix) === uri;
  }
}
