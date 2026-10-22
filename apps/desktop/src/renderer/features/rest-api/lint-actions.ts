/**
 * Linting a REST API's cached definition (#342): the findings go to Problems, grouped by API, so
 * a lint again replaces only that API's rows.
 *
 * Shared by the `rest.lintDefinition` command and the explorer's menu, and run quietly after an
 * OpenAPI import and an applied definition update.
 */

import { matchOperation } from '@wirebench/engine/rest';
import { showToast } from '../../components/toast.js';
import { lintOperation } from '../problems/lint-location.js';
import { openRestRequestTab } from '../rest-editor/rest-actions.js';
import { openApiTab } from './api-actions.js';
import { ipc } from '../../state/ipc-client.js';
import { useProblemsStore } from '../../state/problems.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';

export interface LintRestOptions {
  /** Open Problems afterwards and say what went wrong — for a lint the user asked for. */
  readonly reveal: boolean;
}

/** Lints `apiId`'s cached definition. Does nothing for an API that did not cache one. */
export async function lintRestDefinition(apiId: string, options: LintRestOptions): Promise<void> {
  if (useProjectStore.getState().apis[apiId]?.definition?.cache !== true) {
    return;
  }
  let result;
  try {
    result = await ipc().api.restLint({ apiId });
  } catch (error: unknown) {
    if (options.reveal) showToast(`Lint failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!result.ok) {
    if (options.reveal) showToast(`Lint failed: ${result.error.message}`);
    return;
  }
  useProblemsStore.getState().setLint(apiId, result.value.findings);
  if (options.reveal) {
    // Lint has its own list in Problems (#745); a lint the user asked for opens that list.
    useProblemsStore.getState().setFilter('lint');
    useUiStore.getState().showConsoleTab('problems');
    if (result.value.findings.length === 0) showToast('Lint found no problems.');
  }
}

/**
 * Opens what a lint finding is about: the API's request for the operation its pointer sits in, or
 * the API's own tab when the pointer is not in an operation or no request calls it.
 */
export function revealLintFinding(apiId: string, pointer: string): void {
  const { apis, restRequests } = useProjectStore.getState();
  const api = apis[apiId];
  const operation = lintOperation(pointer);
  if (api !== undefined && operation !== undefined) {
    const wanted = [{ method: operation.method.toLowerCase(), path: operation.path }];
    const bases = [api.baseUrl, ...api.servers.map((server) => server.url)];
    const request = Object.values(restRequests)
      .filter((candidate) => candidate.apiId === apiId)
      .sort((a, b) => a.order - b.order)
      .find((candidate) => matchOperation(wanted, candidate.method, candidate.url, bases) !== undefined);
    if (request !== undefined) {
      openRestRequestTab(request.id);
      return;
    }
  }
  openApiTab(apiId);
}
