/**
 * Postman environment and globals exports (`values[]` plus `_postman_variable_scope`), turned
 * into the importer-neutral variable plan of spec §3.1. Pure: no file access, no secret store.
 */
import { PostmanError } from '#core/errors';
import { ReportBuilder } from '#core/import/report';
import { rewriteMustache } from '#core/import/templates';
import type { ImportedVariables } from '#core/import/variables';
import { VariableSetBuilder, warnCredentialLookingNames } from '#core/import/variables';
import type { PostmanSource } from './import.js';
import { readPostmanSource } from './import.js';
import { isPostmanVariables } from './parse.js';

// Lives in parse.ts so import-detect (bundled into the renderer) never reaches import.ts or map.ts.
export { isPostmanVariables };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === undefined || value === null) return '';
  return undefined;
}

export function parsePostmanVariablesText(text: string): ImportedVariables {
  let root: unknown;
  try {
    root = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new PostmanError('postman-malformed', 'The file is not valid JSON', { cause: error });
  }
  if (isRecord(root) && Array.isArray(root['collections']) && Array.isArray(root['environments'])) {
    throw new PostmanError(
      'postman-data-dump',
      'This is a bulk data export. Export each environment on its own and import them one by one.',
    );
  }
  return postmanVariablesOf(root);
}

/**
 * An environment or globals export already parsed — JSON, or the YAML a folder collection keeps in
 * `environments/` and `globals/` — as the variable plan. `scope` says which it is when the document
 * does not: a folder's `globals/` files carry no scope of their own.
 *
 * @throws PostmanError `postman-not-variables` when `root` has no `values` list
 */
export function postmanVariablesOf(root: unknown, scope?: 'environment' | 'globals'): ImportedVariables {
  const detected = isPostmanVariables(root);
  if (!isRecord(root) || !Array.isArray(root['values']) || (scope === undefined && detected === undefined)) {
    throw new PostmanError('postman-not-variables', 'This is not a Postman environment or globals export');
  }
  const kind = scope ?? detected ?? 'environment';

  const report = new ReportBuilder();
  const dynamic = new Set<string>();
  const rawName = typeof root['name'] === 'string' ? root['name'].trim() : '';
  const name = rawName !== '' ? rawName : kind === 'globals' ? 'Globals' : 'Imported environment';
  const set = new VariableSetBuilder(name, report);

  for (const raw of root['values'] as unknown[]) {
    if (!isRecord(raw)) continue;
    const key = typeof raw['key'] === 'string' ? raw['key'].trim() : '';
    if (key === '') {
      report.warn(`${name}: a variable with no name was skipped.`);
      continue;
    }
    const value = scalarText(raw['value']);
    if (value === undefined) {
      report.warn(`${name}: "${key}" has a value that is not text, a number or true/false, so it was skipped.`);
      continue;
    }
    const type = raw['type'];
    if (type !== undefined && type !== 'default' && type !== 'secret' && type !== 'text') {
      report.note(
        `${name}: "${key}" has the unknown type "${typeof type === 'string' ? type : typeof type}" and was imported as a plain variable.`,
      );
    }
    const enabled = raw['enabled'] !== false;
    if (type === 'secret') {
      set.add({ name: key, value: '', enabled, secret: true, ...(value !== '' ? { secretValue: value } : {}) });
    } else {
      set.add({ name: key, value: rewriteMustache(value, dynamic), enabled, secret: false });
    }
  }

  if (dynamic.size > 0) {
    report.warn(`Dynamic variables are kept as written and not expanded: ${[...dynamic].sort().join(', ')}`);
  }
  const built = set.build();
  warnCredentialLookingNames(report, [built]);
  return kind === 'globals'
    ? { environments: [], globals: built, report: report.build() }
    : { environments: [built], report: report.build() };
}

/** Reads and parses a Postman environment or globals export from a file or text. */
export async function importPostmanVariables(source: PostmanSource): Promise<ImportedVariables> {
  return parsePostmanVariablesText(await readPostmanSource(source));
}
