/**
 * `wirebench export` (collection exporters spec §5): the project, or one API or interface, as a
 * Postman Collection v2.1 or an OpenCollection document, written to a folder, then the report of
 * what did not fit. Reads the project; never writes to it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  exportCollection,
  formatImportReport,
  grpcApisOf,
  isWirebenchError,
  restApisOf,
  soapInterfacesOf,
  wsApisOf,
} from '@wirebench/engine';
import type { CollectionExportEnvironment, CollectionExportTarget, Project } from '@wirebench/engine';
import type { ExportArgs } from '../args.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { USAGE_CODES } from '../ops/errors.js';
import { openProject } from '../ops/project.js';

/** The container `wanted` names, by id, slug or name (any case); a message when none or several match. */
function targetFor(project: Project, wanted: string): CollectionExportTarget | string {
  const containers = [
    ...soapInterfacesOf(project),
    ...restApisOf(project),
    ...grpcApisOf(project),
    ...wsApisOf(project),
  ];
  const byId = containers.find((c) => c.id === wanted || c.slug === wanted);
  if (byId !== undefined) return { kind: 'container', id: byId.id };
  const byName = containers.filter((c) => c.name.toLowerCase() === wanted.toLowerCase());
  if (byName.length === 1) return { kind: 'container', id: byName[0]!.id };
  if (byName.length > 1) return `"${wanted}" names ${byName.length} APIs or interfaces; pass a slug or id instead`;
  const known = containers.map((c) => c.name).join(', ');
  return `no API or interface "${wanted}" in the project${known !== '' ? ` (it has: ${known})` : ''}`;
}

export async function exportCommand(args: ExportArgs, io: CliIo): Promise<ExitCode> {
  const warn = (line: string): void => {
    io.stderr.write(`${line}\n`);
  };
  try {
    const opened = await openProject({ projectDir: resolve(args.project), warn });
    const { project } = opened;
    const target: CollectionExportTarget | string =
      args.api === undefined ? { kind: 'project' } : targetFor(project, args.api);
    if (typeof target === 'string') {
      io.stderr.write(`export-target-not-found: ${target}\n`);
      return ExitCode.RunError;
    }
    const workspace = opened.workspace?.workspace;
    const environments: CollectionExportEnvironment[] = [...(workspace?.environments ?? []), ...project.environments];
    const result = exportCollection(args.format, {
      project,
      target,
      environments,
      ...(workspace !== undefined
        ? { workspaceProperties: workspace.properties, workspaceDisabledProperties: workspace.disabledProperties }
        : {}),
    });
    const out = resolve(args.out);
    await mkdir(out, { recursive: true });
    const written: string[] = [];
    for (const file of result.files) {
      const path = join(out, file.name);
      await writeFile(path, file.text, 'utf8');
      written.push(path);
    }
    if (args.json) {
      io.stdout.write(`${JSON.stringify({ files: written, counts: result.counts, report: result.report }, null, 2)}\n`);
    } else {
      for (const path of written) io.stdout.write(`Wrote ${path}\n`);
      const report = formatImportReport(result.report);
      if (report !== '') io.stdout.write(`${report}\n`);
    }
    return ExitCode.Ok;
  } catch (error) {
    if (isWirebenchError(error)) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return USAGE_CODES.has(error.code) ? ExitCode.Usage : ExitCode.RunError;
    }
    throw error;
  }
}
