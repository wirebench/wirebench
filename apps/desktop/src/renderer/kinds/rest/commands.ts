import { folderOf, insideKindApi } from '../../commands/command-helpers.js';
import { catalogEntry } from '@shared/command-catalog.js';
import { explorerActions } from '../../features/explorer/explorer-actions.js';
import { registerCommand } from '../../lib/commands.js';
import { useProjectStore } from '../../state/project.js';
import { copyAsCurl } from '../../features/request-editor/request-actions.js';
import { getOAuth2Token } from '../../features/rest-editor/rest-actions.js';
import { lintRestDefinition } from '../../features/rest-api/lint-actions.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { restSendBlocked } from '../../features/rest-editor/send-blocked.js';
import { activeRestRequestId, ui } from '../../commands/command-helpers.js';

/**
 * Whether the REST API cached its definition. A recorded source is not enough: main refuses an
 * update without the cached document to compare against, so an uncached API would dead-end.
 */
function hasRestDefinition(apiId: string | undefined): boolean {
  return apiId !== undefined && useProjectStore.getState().apis[apiId]?.definition?.cache === true;
}

/** Registers REST's own commands (kind modules spec §6.1). */
export function registerRestCommands(): void {
  // The three REST creators. Each is gated on a selection *anywhere inside* an API — a folder row
  // and a request row both name their API — so "New request" works from wherever the user is
  // rather than only on the API row itself.
  registerCommand({
    ...catalogEntry('rest.newApi'),
    when: (ctx) => ctx.selection?.kind === 'project',
    whenScope: 'selection.project',
    run: (ctx) => {
      explorerActions.newApi(ctx.selection?.id);
    },
  });
  registerCommand({
    ...catalogEntry('rest.newFolder'),
    when: (ctx) => insideKindApi('rest', ctx.selection),
    whenScope: 'selection.api',
    run: (ctx) => {
      explorerActions.newFolder(ctx.selection?.apiId, folderOf(ctx.selection));
    },
  });
  registerCommand({
    ...catalogEntry('rest.newRequest'),
    when: (ctx) => insideKindApi('rest', ctx.selection),
    whenScope: 'selection.api',
    run: (ctx) => {
      explorerActions.newRestRequest(ctx.selection?.apiId, folderOf(ctx.selection));
    },
  });
  registerCommand({
    ...catalogEntry('rest.updateDefinition'),
    when: (ctx) => insideKindApi('rest', ctx.selection) && hasRestDefinition(ctx.selection?.apiId),
    whenScope: 'selection.api',
    run: (ctx) => {
      explorerActions.updateRestDefinition(ctx.selection?.apiId);
    },
  });
  registerCommand({
    ...catalogEntry('rest.lintDefinition'),
    when: (ctx) => insideKindApi('rest', ctx.selection) && hasRestDefinition(ctx.selection?.apiId),
    whenScope: 'selection.api',
    run: (ctx) => {
      const apiId = ctx.selection?.apiId;
      if (apiId !== undefined) void lintRestDefinition(apiId, { reveal: true });
    },
  });
  // A REST tab's own send. It shares `Mod+Enter` with `request.send` because the two can never be
  // active at once — a tab is one kind or the other — which is what the distinct `when` scopes say.
  registerCommand({
    ...catalogEntry('rest.send'),
    when: () => activeRestRequestId() !== undefined,
    whenScope: 'editor.rest',
    run: () => {
      const requestId = activeRestRequestId();
      // Refused while the tab's Send button is disabled (a webhook item with no target).
      if (requestId !== undefined && restSendBlocked(requestId) === undefined) {
        void useExchangesStore.getState().sendRest(requestId);
      }
    },
  });
  // The REST counterparts of the SOAP cURL, token and import actions. Each goes through the same
  // channel its SOAP sibling does, so the palette and the panel can never mean different things.
  registerCommand({
    ...catalogEntry('rest.copyAsCurl'),
    when: () => activeRestRequestId() !== undefined,
    whenScope: 'editor.rest',
    // The same `request.curl` the SOAP command uses, and the same shell the Code panel remembers:
    // the palette and the panel must never hand out two different commands for one request.
    run: () => {
      const requestId = activeRestRequestId();
      if (requestId !== undefined) {
        void copyAsCurl(requestId, ui().slideOver.codeShell);
      }
    },
  });
  registerCommand({
    ...catalogEntry('rest.importCurl'),
    when: () => activeRestRequestId() !== undefined,
    whenScope: 'editor.rest',
    run: () => {
      const requestId = activeRestRequestId();
      const request = requestId === undefined ? undefined : useProjectStore.getState().restRequests[requestId];
      if (request !== undefined) {
        ui().setImportCurlTarget({
          kind: 'rest',
          apiId: request.apiId,
          ...(request.folderId !== undefined ? { folderId: request.folderId } : {}),
        });
      }
    },
  });
  registerCommand({
    ...catalogEntry('rest.getToken'),
    when: () => activeRestRequestId() !== undefined,
    whenScope: 'editor.rest',
    run: () => {
      void getOAuth2Token(activeRestRequestId());
    },
  });
}
