/**
 * OpenCollection's variables and scripts (spec §7.3, §7.4): environments become workspace
 * environments, collection and folder variables project properties, and scripts attach to their
 * level, switched off (module items stay text under `imported-scripts/`). No literal credential reaches a plain value: the import
 * credential rule makes it a secret, whose value travels only in `secretValue`.
 */

import type { ReportBuilder } from '../report.js';
import { uniqueName } from '../report.js';
import type { ImportedScriptFile } from '../scripts.js';
import { importedScriptPath, scriptText } from '../scripts.js';
import { rewriteMustache } from '../templates.js';
import type { ImportedVariable, ImportedVariableSet } from '../variables.js';
import { VariableSetBuilder, credentialSafeVariable } from '../variables.js';
import { slugify } from '../../project/paths.js';
import type { RequestScripts } from '../../script/model.js';
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

/** The key of the collection's own scripts in {@link OcScripts.levels}; every other key is an item's `path`. */
export const OC_COLLECTION_KEY = '';

/** A `module` item: a helper file a script would `require`. Kept as text, because `require` is unsupported. */
export interface OcModule {
  readonly owner: string;
  readonly source: string;
}

export interface OcScripts {
  /** Each level's scripts for the Bruno layer, switched off, keyed by the item's `path`. */
  readonly levels: ReadonlyMap<string, RequestScripts>;
  readonly modules: readonly OcModule[];
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
  const levels = new Map<string, RequestScripts>();
  const modules: OcModule[] = [];
  const attach = (key: string, scripts: readonly OcScript[] | undefined, owner: string): void => {
    const found = levelScripts(scripts, owner, report);
    if (found !== undefined) levels.set(key, found);
  };
  const walk = (items: readonly OcItem[]): void => {
    for (const item of items) {
      const owner = item.info.name;
      if (item.items !== undefined) {
        attach(item.path, item.request?.scripts, owner);
        walk(item.items);
      } else if (item.script !== undefined) {
        modules.push({ owner, source: item.script });
      } else {
        attach(item.path, item.runtime?.scripts, owner);
      }
    }
  };
  attach(OC_COLLECTION_KEY, collection.request?.scripts, collection.info.name);
  walk(collection.items);
  return { levels, modules };
}

/** The module items as files under `imported-scripts/<api>/<owner>.module.js`, in tree order. */
export function ocModuleFiles(
  modules: readonly OcModule[],
  apiSlug: string,
  report: ReportBuilder,
): ImportedScriptFile[] {
  const taken = new Set<string>();
  return modules.map(({ owner, source }) => {
    const path = importedScriptPath(apiSlug, slugify(owner).toLowerCase(), 'module.js', taken);
    report.note(`${owner}: the module script was saved to ${path} and is never run.`);
    return { path, source };
  });
}
