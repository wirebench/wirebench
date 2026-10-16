/**
 * Places a mapped collection import into a project: each collection's REST, gRPC and WebSocket API,
 * the imported scripts (as text), then the variable plan. Shared by every collection-folder and
 * other-client import handler.
 */
import { formatImportReport } from '@wirebench/engine';
import type { MappedClientImport } from '@wirebench/engine';
import type { ImportVariablesSummaryWire } from '../shared/kinds/rest/wire.js';
import type { ProjectWire } from '../shared/wire-types.js';
import type { ApiChannelDeps } from './ipc/api.js';
import { applyImportedVariables } from './import-variables-apply.js';

export interface PlacedImport {
  projectId: string;
  project?: ProjectWire;
  apiIds: string[];
  variables?: ImportVariablesSummaryWire;
  scripts: number;
  warnings: string[];
  notes: string[];
  reportText: string;
}

/**
 * Writes an importer's scripts under `imported-scripts/`, never overwriting one: how many were
 * written, a note for each saved under another name, and a warning for each that was not written.
 */
export async function writeScriptsReported(
  router: Pick<ApiChannelDeps['router'], 'writeImportedScripts'>,
  projectId: string,
  scripts: readonly { readonly path: string; readonly source: string }[],
): Promise<{ readonly written: number; readonly notes: string[]; readonly warnings: string[] }> {
  if (scripts.length === 0) return { written: 0, notes: [], warnings: [] };
  const { written, renamed, skipped } = await router.writeImportedScripts(projectId, scripts);
  return {
    written: written.length,
    notes: renamed.map(({ from, to }) => `A script already existed at ${from}, so this one was saved as ${to}.`),
    warnings: skipped.map(
      (path) => `The script ${path} would have been saved outside imported-scripts/ and was not written.`,
    ),
  };
}

export async function placeMappedImport(
  deps: Pick<ApiChannelDeps, 'router' | 'variablesPorts'>,
  projectId: string,
  mapped: Pick<MappedClientImport, 'collections' | 'variables' | 'report'> &
    Partial<Pick<MappedClientImport, 'scripts'>>,
  meta: { readonly source: string; readonly declaredVersion: string },
): Promise<PlacedImport> {
  const { router } = deps;
  let project: ProjectWire | undefined;
  const apiIds: string[] = [];
  const placed = (added: { readonly project: ProjectWire; readonly apiId: string }) => {
    project = added.project;
    apiIds.push(added.apiId);
  };
  for (const collection of mapped.collections) {
    if (collection.rest !== undefined) {
      placed(
        await router.addApi(projectId, {
          api: collection.rest,
          documents: [],
          source: meta.source,
          declaredVersion: meta.declaredVersion,
          cache: false,
        }),
      );
    }
    if (collection.grpc !== undefined) placed(await router.importGrpcApi(projectId, { api: collection.grpc }));
    if (collection.websocket !== undefined) placed(await router.importWsApi(projectId, { api: collection.websocket }));
  }
  const scripts = await writeScriptsReported(router, projectId, mapped.scripts ?? []);
  const plan = mapped.variables;
  const variables =
    plan.environments.length > 0 || plan.globals !== undefined || plan.projectProperties !== undefined
      ? await applyImportedVariables(plan, deps.variablesPorts(projectId))
      : undefined;
  // The apply result repeats the plan's own report; with nothing applied, the plan's report stands.
  const variableReport = variables ?? plan.report;
  const report = {
    warnings: [...mapped.report.warnings, ...scripts.warnings, ...variableReport.warnings],
    notes: [...mapped.report.notes, ...scripts.notes, ...variableReport.notes],
  };
  return {
    projectId,
    ...(project !== undefined ? { project } : {}),
    apiIds,
    ...(variables !== undefined ? { variables } : {}),
    scripts: scripts.written,
    ...report,
    reportText: formatImportReport(report),
  };
}
