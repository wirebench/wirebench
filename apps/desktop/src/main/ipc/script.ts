/**
 * Registers the `script.*` IPC channels (#63): the script editor's diagnostics, completion, hover
 * and signature help, all answered by main's checker against the request's own types (or, for a
 * mock's `dispatch.ts`, the dispatch API), and a project's session values. Editing a request's scripts goes through `project.mutate`.
 *
 * Nothing here runs a script: the renderer only ever gets the checker's answers and masked values.
 */

import { channels } from '../../shared/ipc.js';
import type { ScriptTargetWire } from '../../shared/wire-types.js';
import type { ScriptHost, ScriptTarget } from '../script-host.js';
import { registerHandler } from './register.js';

/** The script a request names, without the rest of the request. */
function targetOf(request: ScriptTargetWire): ScriptTarget {
  return 'mockId' in request
    ? { mockId: request.mockId, operationId: request.operationId }
    : { requestId: request.requestId, phase: request.phase };
}

export function registerScriptChannels(host: ScriptHost): void {
  registerHandler(channels.script.diagnostics, async (request) => ({
    diagnostics: [...(await host.diagnostics(targetOf(request), request.source))],
  }));
  registerHandler(channels.script.completions, async (request) => ({
    items: (await host.completions(targetOf(request), request.source, request.line, request.column)).map((item) => ({
      name: item.name,
      kind: item.kind,
      ...(item.detail !== undefined ? { detail: item.detail } : {}),
    })),
  }));
  registerHandler(channels.script.quickInfo, async (request) => {
    const info = await host.quickInfo(targetOf(request), request.source, request.line, request.column);
    return info === undefined ? {} : { info: { ...info } };
  });
  registerHandler(channels.script.signatureHelp, async (request) => {
    const help = await host.signatureHelp(targetOf(request), request.source, request.line, request.column);
    return help === undefined ? {} : { help: { ...help, parameters: [...help.parameters] } };
  });
  registerHandler(channels.script.closeModel, async (request) => {
    await host.closeModel(targetOf(request));
    return {};
  });
  registerHandler(channels.script.listValues, ({ projectId }) =>
    Promise.resolve({ values: host.listValues(projectId) }),
  );
  registerHandler(channels.script.clearValues, ({ projectId }) =>
    Promise.resolve({ cleared: host.clearValues(projectId) }),
  );
}
