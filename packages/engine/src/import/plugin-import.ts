/**
 * A plugin importer's result placed as a built-in import is (phase 7 spec §3.1): each API becomes a
 * Postman v2.1 document the REST mapper already reads, so a plugin's requests get the same names,
 * slugs, URL handling and report as an exported collection's. Secret variables are reported and never
 * written; their values are not even carried.
 */
import type { PluginImportData, PluginImportedItem } from '#core/extension/plugin/results';
import { ReportBuilder } from '#core/import/report';
import type { ImportedVariable, ImportedVariableSet } from '#core/import/variables';
import type { IdGenerator } from '#core/project/model';
import { apiFromPostmanCollection } from '#protocol-rest/rest/postman/map';
import { parsePostmanCollection } from '#protocol-rest/rest/postman/parse';
import type { MappedClientEntry, MappedClientImport } from './client-import.js';

type Json = Record<string, unknown>;

/** `${name}` as the v2.1 mapper reads a variable, `{{name}}`. */
const mustache = (text: string): string => text.replace(/\$\{([A-Za-z_][\w.-]*)\}/g, '{{$1}}');

function v21Item(item: PluginImportedItem): Json {
  if (item.kind === 'folder') return { name: item.name, item: item.items.map(v21Item) };
  const body =
    item.body === undefined
      ? undefined
      : item.body.kind === 'raw'
        ? { mode: 'raw', raw: mustache(item.body.text) }
        : {
            mode: 'urlencoded',
            urlencoded: item.body.fields.map((field) => ({ key: field.name, value: mustache(field.value) })),
          };
  const headers = [
    ...(item.headers ?? []).map((header) => ({ key: header.name, value: mustache(header.value) })),
    ...(item.body?.kind === 'raw' && item.body.contentType !== undefined
      ? [{ key: 'Content-Type', value: item.body.contentType }]
      : []),
  ];
  return {
    name: item.name,
    request: {
      method: item.method.toUpperCase(),
      url: { raw: mustache(item.url) },
      header: headers,
      ...(body !== undefined ? { body } : {}),
      ...(item.description !== undefined ? { description: item.description } : {}),
    },
  };
}

function countOf(items: readonly PluginImportedItem[]): { requests: number; folders: number } {
  let requests = 0;
  let folders = 0;
  for (const item of items) {
    if (item.kind === 'request') requests += 1;
    else {
      folders += 1;
      const inner = countOf(item.items);
      requests += inner.requests;
      folders += inner.folders;
    }
  }
  return { requests, folders };
}

function variableSet(
  name: string,
  variables: readonly { name: string; value: string; secret?: boolean | undefined }[],
  report: ReportBuilder,
  title: string,
): ImportedVariableSet {
  const out: ImportedVariable[] = [];
  let secrets = 0;
  for (const variable of variables) {
    if (variable.secret === true) {
      secrets += 1;
      out.push({ name: variable.name, value: '', enabled: true, secret: true, awaitsValue: true });
    } else {
      out.push({ name: variable.name, value: variable.value, enabled: true, secret: false });
    }
  }
  if (secrets > 0) {
    report.warn(
      `${title}: ${String(secrets)} secret ${secrets === 1 ? 'value was' : 'values were'} not imported; enter them again`,
    );
  }
  return { name, variables: out };
}

export function mapPluginImport(
  result: PluginImportData,
  title: string,
  options: { readonly newId?: IdGenerator; readonly firstOrder?: number } = {},
): MappedClientImport {
  const report = new ReportBuilder();
  for (const warning of result.report?.warnings ?? []) report.warn(`${title}: ${warning}`);
  for (const note of result.report?.notes ?? []) report.note(`${title}: ${note}`);
  let order = options.firstOrder ?? 0;
  let requests = 0;
  let folders = 0;
  const collections: MappedClientEntry[] = [];
  for (const api of result.apis) {
    const counts = countOf(api.items);
    requests += counts.requests;
    folders += counts.folders;
    const parsed = parsePostmanCollection({
      info: {
        name: api.name,
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        ...(api.description !== undefined ? { description: api.description } : {}),
      },
      item: api.items.map(v21Item),
    });
    const mapped = apiFromPostmanCollection(parsed, {
      name: api.name,
      order: order++,
      ...(options.newId !== undefined ? { newId: options.newId } : {}),
    });
    for (const warning of mapped.summary.warnings ?? []) report.warn(`${api.name}: ${warning}`);
    collections.push({ name: api.name, ...(counts.requests > 0 ? { rest: mapped.api } : {}) });
  }
  const variablesReport = new ReportBuilder();
  const projectProperties =
    result.variables !== undefined && result.variables.length > 0
      ? variableSet('Project properties', result.variables, variablesReport, title)
      : undefined;
  const environments = (result.environments ?? []).map((environment) =>
    variableSet(environment.name, environment.variables, variablesReport, `${title} environment "${environment.name}"`),
  );
  return {
    collections,
    variables: {
      environments,
      ...(projectProperties !== undefined ? { projectProperties } : {}),
      report: variablesReport.build(),
    },
    scripts: [],
    counts: { collections: result.apis.length, requests, folders, examples: 0, assertions: 0, scripts: 0 },
    report: report.build(),
  };
}
