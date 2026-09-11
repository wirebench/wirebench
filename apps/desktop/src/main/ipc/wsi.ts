/**
 * The `wsi.*` channels: WS-I Basic Profile 1.1 conformance reports, and their HTML export.
 *
 * Everything that does the work — the assertion catalogues, both runners, the HTML renderer —
 * lives in the engine, which is a main-process dependency (it reaches the file system and, for
 * schema work, libxml2). The renderer only ever receives a finished report, and the export is
 * rendered and written here so no HTML string round-trips through the bridge twice.
 */

import { writeFile } from 'node:fs/promises';
import {
  ProjectError,
  WirebenchError,
  messageBindingFor,
  renderWsiReportHtml,
  runMessageAssertions,
  runWsdlAssertions,
  wsiWsdlContext,
} from '@wirebench/engine';
import type { QName, WsiReport } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { WsiReportWire } from '../../shared/wire-types.js';
import type { EngineService } from '../engine-service.js';
import type { ProjectService } from '../project-service.js';
import type { RecordsWritePicks } from '../dialog-picks.js';
import { registerHandler } from './register.js';

/** The `ProjectService` surface the `wsi.*` channels need; a stub stands in for it in tests. */
export type WsiChannelProject = Pick<ProjectService, 'validationTargetFor' | 'snapshot'>;

/** How the caller asks for a save location; `dialogs.saveFile`'s own handler is not reusable here. */
export interface WsiSaveDialog {
  /** Returns the chosen path, or `undefined` when the user cancelled. */
  showSave(options: { defaultPath: string; title: string }): Promise<string | undefined>;
}

/** Parses a Clark-notation QName string (`{namespaceUri}localName`) back into a `QName`. */
function parseClarkQName(clark: string): QName {
  const match = /^\{([^}]*)\}(.*)$/.exec(clark);
  if (match === null) {
    return { namespaceUri: '', localName: clark };
  }
  const [, namespaceUri, localName] = match;
  return { namespaceUri: namespaceUri ?? '', localName: localName ?? '' };
}

/** Adds the two wire-only fields the renderer needs on top of the engine's report. */
function toWire(report: WsiReport, label: string, scope: 'wsdl' | 'message'): WsiReportWire {
  return {
    target: report.target,
    profile: report.profile,
    summary: { ...report.summary },
    assertions: report.assertions.map((assertion) => ({
      id: assertion.id,
      title: assertion.title,
      level: assertion.level,
      section: assertion.section,
      result: assertion.result,
      findings: assertion.findings.map((finding) => ({
        message: finding.message,
        ...(finding.location !== undefined ? { location: { ...finding.location } } : {}),
      })),
    })),
    label,
    scope,
  };
}

/**
 * Narrows a wire report back to the engine's `WsiReport`. The zod-inferred shape types every
 * optional field as `T | undefined`, which `exactOptionalPropertyTypes` will not accept where the
 * engine declares `T?`, so the optional keys are re-spread rather than passed through.
 */
function fromWire(report: WsiReportWire): WsiReport {
  return {
    target: report.target,
    profile: report.profile,
    summary: report.summary,
    assertions: report.assertions.map((assertion) => ({
      id: assertion.id,
      title: assertion.title,
      level: assertion.level,
      section: assertion.section,
      result: assertion.result,
      findings: assertion.findings.map((finding) => ({
        message: finding.message,
        ...(finding.location !== undefined
          ? {
              location: {
                document: finding.location.document,
                ...(finding.location.line !== undefined ? { line: finding.location.line } : {}),
                ...(finding.location.column !== undefined ? { column: finding.location.column } : {}),
                ...(finding.location.xpath !== undefined ? { xpath: finding.location.xpath } : {}),
              },
            }
          : {}),
      })),
    })),
  };
}

/** Everything {@link registerWsiChannels} needs from the rest of main. */
export interface WsiChannelDeps {
  readonly project: WsiChannelProject;
  readonly picks: RecordsWritePicks;
  readonly dialog: WsiSaveDialog;
  /** Injected so the exported document is a deterministic function of its input in tests. */
  readonly now?: () => Date;
}

/**
 * Registers `wsi.checkWsdl`, `wsi.checkExchange` and `wsi.exportHtml`.
 *
 * Reports are always produced verbosely: the panel (and the export) decide whether to *show* the
 * passing rows, and re-running the catalogue just to reveal them would be wasteful and, for a
 * message report, would need an exchange that may since have been evicted.
 */
export function registerWsiChannels(service: EngineService, deps: WsiChannelDeps): void {
  registerHandler(channels.wsi.checkWsdl, (request) => {
    const result = service.resultFor(request.interfaceId);
    const report = runWsdlAssertions(wsiWsdlContext(result), { verbose: true });
    const name = deps.project.snapshot()?.interfaces.find((iface) => iface.id === request.interfaceId)?.name;
    return Promise.resolve(toWire(report, name ?? request.interfaceId, 'wsdl'));
  });

  registerHandler(channels.wsi.checkExchange, (request) => {
    const cached = service.exchanges.getExchange(request.sendId);
    if (cached === undefined) {
      throw new WirebenchError(
        'unknown-exchange',
        `No cached exchange with id "${request.sendId}" — it may have been evicted; send again.`,
        { details: { sendId: request.sendId } },
      );
    }
    const target = cached.requestId === undefined ? undefined : deps.project.validationTargetFor(cached.requestId);
    if (target === undefined) {
      throw new ProjectError(
        'unknown-request',
        'This exchange is not tied to a saved request, so its binding cannot be resolved.',
        { details: { sendId: request.sendId } },
      );
    }
    const definition = service.resultFor(target.interfaceId).definition;
    const binding = messageBindingFor(definition, {
      bindingName: parseClarkQName(target.bindingName),
      operationName: target.operationName,
    });
    if (binding === undefined) {
      throw new ProjectError(
        'unknown-operation',
        `${target.bindingName} has no SOAP operation "${target.operationName}"`,
        { details: { sendId: request.sendId, operationName: target.operationName } },
      );
    }
    const report = runMessageAssertions(cached.exchange, {
      binding,
      direction: 'request',
      ...(cached.requestEnvelopeXml !== undefined ? { requestEnvelopeXml: cached.requestEnvelopeXml } : {}),
      verbose: true,
    });
    return Promise.resolve(toWire(report, `${target.operationName} — last exchange`, 'message'));
  });

  registerHandler(channels.wsi.exportHtml, async (request) => {
    const path = await deps.dialog.showSave({
      defaultPath: request.suggestedName,
      title: 'Export WS-I report',
    });
    if (path === undefined) {
      return { cancelled: true };
    }
    deps.picks.rememberWrite(path);
    const html = renderWsiReportHtml(fromWire(request.report), {
      title: request.report.label,
      generatedAt: (deps.now?.() ?? new Date()).toISOString(),
      ...(request.verbose !== undefined ? { verbose: request.verbose } : {}),
    });
    await writeFile(path, html, 'utf-8');
    return { path, cancelled: false };
  });
}
