/**
 * The static half of a script's types (spec §API): the declarations every script has, followed by
 * the ones its protocol's scripting facet supplies for the phase. Those refer to aliases the
 * generated half defines from the request's contract (`<protocol>/script-types.ts`), and to
 * `WbSecretName`.
 *
 * A script is a global script, not a module: these are ambient declarations, one file per script.
 */
import type { ProtocolScripting } from '../../protocol/module.js';
import type { ProtocolRegistry } from '../../protocol/registry.js';
import { defaultRegistry } from '../../protocols.js';
import { requireScripting } from '../lookup.js';
import type { ScriptPhase } from '../model.js';
import { dispatchReference } from './dispatch.js';
import { SCRIPT_UTILITIES } from './utilities.js';

/** What every request script has besides {@link SCRIPT_UTILITIES}. */
const COMMON = `
/** A case-insensitive list of headers (or gRPC metadata), in order. Names may repeat. */
interface WbPairs {
  get(name: string): string | undefined;
  getAll(name: string): string[];
  has(name: string): boolean;
  list(): { name: string; value: string }[];
  toObject(): Record<string, string>;
}
/** Headers a pre-request script can change. A value may not hold CR, LF or NUL. */
interface WbWritablePairs extends WbPairs {
  /** Replaces every entry of that name with one, where the first one was. */
  set(name: string, value: string): void;
  add(name: string, value: string): void;
  delete(name: string): void;
}

interface WbExpectation<T> {
  toBe(expected: T): void;
  toEqual(expected: T): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toBeNull(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toContain(item: T extends readonly (infer I)[] ? I : string): void;
  toMatch(pattern: RegExp | string): void;
  toBeGreaterThan(value: number): void;
  toBeLessThan(value: number): void;
  toHaveLength(length: number): void;
  toHaveProperty(path: string | readonly string[], value?: unknown): void;
  readonly not: Omit<WbExpectation<T>, 'not'>;
}

/** This run's values: set here, read by later requests as \`\${#Sequence#name}\`. */
declare const vars: {
  get(name: string): string | undefined;
  /** A value is used exactly as set: never expanded, always escaped where it lands. */
  set(name: string, value: string | number | boolean, options?: { secret?: boolean }): void;
};
/** Resolved properties. A secret is never returned. */
declare const props: { get(name: string): string | undefined };
/** The secrets this request's \`scripts.secrets\` lists, and no others. */
declare const secrets: { get(name: WbSecretName): string };
/** Records a test; a failed \`expect\` inside it fails the test, and the script goes on. */
declare function test(name: string, check: () => void): void;
declare function expect<T>(actual: T): WbExpectation<T>;
`;

/**
 * The API's declarations for one protocol and phase. `scripting` is the protocol's facet, or its
 * `kind`, looked up in `registry` (the built-in one when absent).
 *
 * @throws WirebenchError `script-unsupported` when a `kind` has no scripting facet
 */
export function apiDeclarations(
  scripting: ProtocolScripting | string,
  phase: ScriptPhase,
  registry?: ProtocolRegistry,
): string {
  return [SCRIPT_UTILITIES, COMMON, requireScripting(scripting, registry).declarations(phase)].join('\n');
}

/**
 * Everything a script is checked against: the API, its secret names, and the request's generated types.
 *
 * @throws WirebenchError `script-unsupported` when a `kind` has no scripting facet
 */
export function scriptDeclarations(
  scripting: ProtocolScripting | string,
  phase: ScriptPhase,
  secrets: readonly string[],
  generated: string,
  registry?: ProtocolRegistry,
): string {
  return `${apiDeclarations(scripting, phase, registry)}\n${secretNameType(secrets)}\n${generated}`;
}

/** `type WbSecretName = ...` for the secrets a request lists (`never` when it lists none). */
export function secretNameType(secrets: readonly string[]): string {
  const names = secrets.map((name) => JSON.stringify(name));
  return `type WbSecretName = ${names.length > 0 ? names.join(' | ') : 'never'};\n`;
}

/** One section of the published API reference: a heading and the declarations it shows. */
export interface ApiReferenceSection {
  readonly title: string;
  readonly declarations: string;
}

/** Orders two protocols' sections by the title of the first, in code-unit order. */
function byFirstTitle(a: readonly ApiReferenceSection[], b: readonly ApiReferenceSection[]): number {
  const left = a[0]?.title ?? '';
  const right = b[0]?.title ?? '';
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The API's declarations as the docs site's reference shows them (`pnpm docs:script-api`): what
 * every script has, what every request script has, the sections of each protocol in `registry` that
 * has a scripting facet, and last a mock's dispatch API (`./dispatch.ts`). Protocols are ordered by title, not by registration, so the page does not depend on the order a
 * host composed its modules in. The status literal types are described rather than listed.
 */
export function apiReference(registry: ProtocolRegistry = defaultRegistry()): readonly ApiReferenceSection[] {
  const perProtocol = registry.modules
    .map((module) => module.scripting?.reference() ?? [])
    .filter((sections) => sections.length > 0)
    .sort(byFirstTitle);
  return [
    { title: 'Every script', declarations: SCRIPT_UTILITIES },
    { title: 'Every request script', declarations: COMMON },
    ...perProtocol.flat(),
    dispatchReference(),
  ].map((section) => ({
    title: section.title,
    declarations: section.declarations.trim(),
  }));
}
