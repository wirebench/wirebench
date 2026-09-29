/**
 * Registers the `script.*` IPC channels (#63): the script editor's diagnostics, completion, hover
 * and signature help, all answered by main's checker against the request's own types, and a
 * project's session values. Editing a request's scripts goes through `project.mutate`.
 *
 * Nothing here runs a script: the renderer only ever gets the checker's answers and masked values.
 */

import { channels } from '../../shared/ipc.js';
import type { ScriptHost } from '../script-host.js';
import { registerHandler } from './register.js';

export function registerScriptChannels(host: ScriptHost): void {
  registerHandler(channels.script.diagnostics, async ({ requestId, phase, source }) => ({
    diagnostics: [...(await host.diagnostics(requestId, phase, source))],
  }));
  registerHandler(channels.script.completions, async ({ requestId, phase, source, line, column }) => ({
    items: (await host.completions(requestId, phase, source, line, column)).map((item) => ({
      name: item.name,
      kind: item.kind,
      ...(item.detail !== undefined ? { detail: item.detail } : {}),
    })),
  }));
  registerHandler(channels.script.quickInfo, async ({ requestId, phase, source, line, column }) => {
    const info = await host.quickInfo(requestId, phase, source, line, column);
    return info === undefined ? {} : { info: { ...info } };
  });
  registerHandler(channels.script.signatureHelp, async ({ requestId, phase, source, line, column }) => {
    const help = await host.signatureHelp(requestId, phase, source, line, column);
    return help === undefined ? {} : { help: { ...help, parameters: [...help.parameters] } };
  });
  registerHandler(channels.script.closeModel, async ({ requestId, phase }) => {
    await host.closeModel(requestId, phase);
    return {};
  });
  registerHandler(channels.script.listValues, ({ projectId }) =>
    Promise.resolve({ values: host.listValues(projectId) }),
  );
  registerHandler(channels.script.clearValues, ({ projectId }) =>
    Promise.resolve({ cleared: host.clearValues(projectId) }),
  );
}
