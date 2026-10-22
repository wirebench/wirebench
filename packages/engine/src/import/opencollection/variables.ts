/**
 * OpenCollection's variables and scripts (spec §7.3, §7.4): environments become workspace
 * environments, collection and folder variables project properties, and scripts attach to their
 * level, switched off (module items stay text under `imported-scripts/`). No literal credential reaches a plain value: the import
 * credential rule makes it a secret, whose value travels only in `secretValue`.
 */

import type { ReportBuilder } from '#core/import/report';
import { uniqueName } from '#core/import/report';
import type { ImportedScriptFile } from '#core/import/scripts';
import { importedScriptPath, scriptText } from '#core/import/scripts';
import { rewriteMustache } from '#core/import/templates';
import type { ImportedVariable, ImportedVariableSet } from '#core/import/variables';
import { VariableSetBuilder, credentialSafeVariable } from '#core/import/variables';
import { slugify } from '#core/project/paths';
import type { RequestScripts } from '#core/script/model';
import type { OcCollection, OcEnvironment, OcItem, OcScript, OcVariable } from './model.js';

type Scalar = string | number | boolean;

function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A variable's value as text: a scalar, or the selected entry (else the first) of a variant list. */
function valueOf(v: OcVariable, where: string, report: ReportBuilder): string | undefined {
  const raw = v.value;
  if (raw === undefined || raw === null) return '';
  if (isScalar(raw)) return String(raw);
  if (Array.isArray(raw)) {
    const variants = raw.filter(isRecord);
    const chosen = variants.find((variant) => variant['selected'] === true) ?? variants[0];
    const picked = chosen?.['value'];
    if (isScalar(picked)) {
      if (variants.length > 1) report.note(`${where}: "${v.name}" has several values; the selected one was used.`);
      return String(picked);
    }
  }
  report.note(
    Array.isArray(raw)
      ? `${where}: the variant value of "${v.name}" was unreadable and was skipped.`
      : `${where}: "${v.name}" has an object value and was skipped.`,
  );
  return undefined;
}

/**
 * One variable under the credential rule. A `secret: true` one travels as a secret, with its value
 * when it has one (the desktop warns when it has none); a credential-named literal becomes a
 * secret; literal user info is cut from a URL.
 */
function importedVariable(
  v: OcVariable,
  where: string,
  report: ReportBuilder,
  dynamic: Set<string>,
): ImportedVariable | undefined {
  const raw = valueOf(v, where, report);
  if (raw === undefined) return undefined;
  // Dynamic names are collected aside and kept only for a plain value: nothing of a secret's text reaches the report.
  const seen = new Set<string>();
  const text = rewriteMustache(raw, seen);
  const enabled = v.disabled !== true;
  if (v.secret === true) {
    return { name: v.name, value: '', enabled, secret: true, ...(text !== '' ? { secretValue: text } : {}) };
  }
  const { variable, madeSecret, userinfoCut } = credentialSafeVariable(v.name, text, enabled);
  if (!variable.secret) for (const name of seen) dynamic.add(name);
  if (madeSecret) {
    report.note(
      `${where}: "${v.name}" looks like a credential, so its value was imported as a secret rather than plain text.`,
    );
  }
  if (userinfoCut) report.warn(`${where}: the credential in the URL of "${v.name}" was not imported.`);
  return variable;
}

/**
 * The environments, in order. A name already taken earlier in the collection (the same name in
 * `config.environments` and `environments/`) is numbered as an import numbers any clashing name.
 * Each environment's unsupported features are reported.
 */
export function mapOcEnvironments(
  envs: readonly OcEnvironment[],
  report: ReportBuilder,
  dynamic: Set<string> = new Set(),
): ImportedVariableSet[] {
  const taken: string[] = [];
  return envs.map((env) => {
    const name = uniqueName(env.name, taken);
    taken.push(name);
    if (name !== env.name) {
      report.note(
        `An environment named "${env.name}" appears more than once in the collection, so this one was imported as "${name}".`,
      );
    }
    for (const extra of env.extras) report.warn(`${name}: ${extra} is not supported and was not imported.`);
    const builder = new VariableSetBuilder(name, report);
    for (const v of env.variables) {
      const variable = importedVariable(v, name, report, dynamic);
      if (variable !== undefined) builder.add(variable);
    }
    return builder.build();
  });
}

/** The folders of `items`, depth first in item order. */
function* foldersOf(items: readonly OcItem[]): Generator<OcItem> {
  for (const item of items) {
    if (item.items === undefined) continue;
    yield item;
    yield* foldersOf(item.items);
  }
}

/**
 * The collection's `request.variables`, then each folder's in walk order, as project properties;
 * the first definition wins. Absent when there are none.
 */
export function mapOcProjectVariables(
  collection: OcCollection,
  report: ReportBuilder,
  dynamic: Set<string> = new Set(),
): ImportedVariableSet | undefined {
  const label = 'Project properties';
  const builder = new VariableSetBuilder(label, report);
  const add = (variables: readonly OcVariable[] | undefined, where?: string): void => {
    for (const v of variables ?? []) {
      const variable = importedVariable(v, label, report, dynamic);
      if (variable !== undefined) builder.add(variable, where);
    }
  };
  add(collection.request?.variables);
  for (const folder of foldersOf(collection.items)) add(folder.request?.variables, `folder "${folder.info.name}"`);
  return builder.size > 0 ? builder.build() : undefined;
}

/** A warning for each request with variables of its own: Wirebench has no request scope. */
export function reportOcRequestVariables(items: readonly OcItem[], report: ReportBuilder): void {
  for (const item of items) {
    if (item.items !== undefined) {
      reportOcRequestVariables(item.items, report);
      continue;
    }
    const names = (item.runtime?.variables ?? []).map((v) => v.name);
    if (names.length > 0) {
      report.warn(
        `${item.info.name}: request-level variables (${names.join(', ')}) were not imported; Wirebench has no request scope.`,
      );
    }
  }
}

/** A warning for each collection setting not read, and each directory file that did not parse. */
export function reportOcConfigExtras(collection: OcCollection, report: ReportBuilder): void {
  for (const extra of collection.configExtras) {
    if (extra.startsWith('unreadable:')) {
      report.warn(`${extra.slice('unreadable:'.length)} could not be read and was skipped.`);
    } else {
      report.warn(`The collection's ${extra} setting is not supported and was not imported.`);
    }
  }
}

/** A `module` item: a helper file a script would `require`. Kept as text, because `require` is unsupported. */
export interface OcModule {
  readonly owner: string;
  readonly source: string;
}

export interface OcScripts {
  /** The collection's own scripts for the Bruno layer, switched off. */
  readonly collection?: RequestScripts;
  /**
   * Each folder's and request's, keyed by the item object itself: a name or a path can repeat
   * (a Bruno export gives its items no path of their own), the object cannot.
   */
  readonly levels: ReadonlyMap<OcItem, RequestScripts>;
  readonly modules: readonly OcModule[];
}

/** A level's script that no API of the import could hold, kept as text. */
export interface OcLooseScript {
  readonly owner: string;
  readonly phase: 'before-request' | 'after-response';
  readonly source: string;
}

const LEVEL_TYPES = new Set(['before-request', 'after-response', 'tests']);

/**
 * One level's scripts as the Bruno layer's pair: `before-request` is the pre script, and
 * `after-response` and `tests` join into the post one, the tests second. Anything else has no
 * Wirebench equivalent and is named in the report.
 */
function levelScripts(
  scripts: readonly OcScript[] | undefined,
  owner: string,
  report: ReportBuilder,
): RequestScripts | undefined {
  const codes = (type: string): string[] =>
    (scripts ?? []).filter((s) => s.type === type && s.code.trim() !== '').map((s) => s.code);
  for (const s of scripts ?? []) {
    if (!LEVEL_TYPES.has(s.type) && s.code.trim() !== '') {
      report.warn(`${owner}: the ${s.type} script has no Wirebench equivalent and was not imported.`);
    }
  }
  const pre = codes('before-request');
  // `tests` run after the post-response script whatever order the file lists them in.
  const ordered = [...codes('after-response'), ...codes('tests')];
  if (pre.length === 0 && ordered.length === 0) return undefined;
  return {
    ...(pre.length > 0 ? { pre: { text: scriptText(pre) } } : {}),
    ...(ordered.length > 0 ? { post: { text: scriptText(ordered) } } : {}),
    api: 'bruno',
    enabled: false,
    secrets: [],
  };
}

/**
 * Every script of a collection: the collection's, each folder's and each request's attached for the
 * Bruno layer and switched off, and each script file item (type `module`) kept as text.
 */
export function mapOcScripts(collection: OcCollection, report: ReportBuilder): OcScripts {
  const levels = new Map<OcItem, RequestScripts>();
  const modules: OcModule[] = [];
  const walk = (items: readonly OcItem[]): void => {
    for (const item of items) {
      const owner = item.info.name;
      if (item.items !== undefined) {
        const found = levelScripts(item.request?.scripts, owner, report);
        if (found !== undefined) levels.set(item, found);
        walk(item.items);
      } else if (item.script !== undefined) {
        modules.push({ owner, source: item.script });
      } else {
        const found = levelScripts(item.runtime?.scripts, owner, report);
        if (found !== undefined) levels.set(item, found);
      }
    }
  };
  const own = levelScripts(collection.request?.scripts, collection.info.name || 'Collection', report);
  walk(collection.items);
  return { ...(own !== undefined ? { collection: own } : {}), levels, modules };
}

/**
 * The files under `imported-scripts/<api>/` an import still writes: the module items as
 * `<owner>.module.js`, then the scripts of levels no API could hold as `<owner>.<phase>.js`.
 */
export function ocTextFiles(
  modules: readonly OcModule[],
  loose: readonly OcLooseScript[],
  apiSlug: string,
  report: ReportBuilder,
): ImportedScriptFile[] {
  const taken = new Set<string>();
  const files: ImportedScriptFile[] = [];
  for (const { owner, source } of modules) {
    const path = importedScriptPath(apiSlug, slugify(owner).toLowerCase(), 'module.js', taken);
    report.note(`${owner}: the module script was saved to ${path} and is never run.`);
    files.push({ path, source });
  }
  for (const { owner, phase, source } of loose) {
    const path = importedScriptPath(apiSlug, slugify(owner).toLowerCase(), `${phase}.js`, taken);
    report.note(
      `${owner}: its ${phase} script has no place to run in Wirebench, so it was saved to ${path} and is never run.`,
    );
    files.push({ path, source });
  }
  return files;
}
