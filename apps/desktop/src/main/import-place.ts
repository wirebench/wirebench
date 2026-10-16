/**
 * Placing a mapped collection import in a project (spec 2026-10-15 §3.1): each source collection's
 * REST, gRPC and WebSocket API in that order, the scripts under `imported-scripts/` (never run),
 * then the variable plan — workspace environments never activated, Globals and project properties
 * never overwriting a name. One path for the folder (v3) importer and every other client's format.
 */

import { formatImportReport } from '@wirebench/engine';
import type { ImportedScriptFile, ImportedVariables, ImportReport, MappedClientEntry } from '@wirebench/engine';
import type { ProjectWire } from '../shared/wire-types.js';
import type { ImportVariablesSummaryWire } from '../shared/kinds/rest/wire.js';
import type { ApiChannelDeps } from './ipc/api.js';
import { applyImportedVariables } from './import-variables-apply.js';

export interface PlacedImport {
  readonly projectId: string;
  /** Absent when the import held only variables, so no API was placed. */
  readonly project?: ProjectWire;
  readonly apiIds: string[];
  readonly variables?: ImportVariablesSummaryWire;
  /** Scripts written under `imported-scripts/`. */
  readonly scripts: number;
  readonly warnings: string[];
  readonly notes: string[];
  readonly reportText: string;
}

export interface MappedForPlacing {
  readonly collections: readonly MappedClientEntry[];
  readonly variables: ImportedVariables;
  readonly report: ImportReport;
  readonly scripts?: readonly ImportedScriptFile[];
}

/**
 * Places `mapped` in `projectId`. `meta.source` is recorded on each REST API as where it came from,
 * `meta.declaredVersion` as the format it was read as.
 */
export async function placeMappedImport(
  deps: Pick<ApiChannelDeps, 'router' | 'variablesPorts'>,
  projectId: string,
  mapped: MappedForPlacing,
  meta: { readonly source: string; readonly declaredVersion: string },
): Promise<PlacedImport> {
  const { router } = deps;
  let project: ProjectWire | undefined;
  const apiIds: string[] = [];
  const placed = (added: { readonly project: ProjectWire; readonly apiId: string }): void => {
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
    if (collection.grpc !== undefined) {
      const protos = collection.grpcProtos;
      placed(
        protos !== undefined && protos.roots.length > 0
          ? await router.addGrpcApi(projectId, {
              api: collection.grpc,
              roots: protos.roots,
              source: meta.source,
              kind: 'proto',
              sources: new Map(protos.sources),
            })
          : await router.importGrpcApi(projectId, { api: collection.grpc }),
      );
    }
    if (collection.websocket !== undefined) placed(await router.importWsApi(projectId, { api: collection.websocket }));
  }

  const warnings: string[] = [...mapped.report.warnings];
  const notes: string[] = [...mapped.report.notes];
  let scripts = 0;
  if (mapped.scripts !== undefined && mapped.scripts.length > 0) {
    const { written, renamed, skipped } = await router.writeImportedScripts(projectId, mapped.scripts);
    scripts = written.length;
    notes.push(
      ...renamed.map(({ from, to }) => `A script already existed at ${from}, so this one was saved as ${to}.`),
    );
    warnings.push(
      ...skipped.map(
        (path) => `The script ${path} would have been saved outside imported-scripts/ and was not written.`,
      ),
    );
  }

  const plan = mapped.variables;
  const variables =
    plan.environments.length > 0 || plan.globals !== undefined || plan.projectProperties !== undefined
      ? await applyImportedVariables(plan, deps.variablesPorts(projectId))
      : undefined;
  // The apply result repeats the plan's own report; with nothing applied, the plan's report stands.
  const variableReport = variables ?? plan.report;
  warnings.push(...variableReport.warnings);
  notes.push(...variableReport.notes);
  return {
    projectId,
    ...(project !== undefined ? { project } : {}),
    apiIds,
    ...(variables !== undefined ? { variables } : {}),
    scripts,
    warnings,
    notes,
    reportText: formatImportReport({ warnings, notes }),
  };
}
