/**
 * Linting a REST API's cached definition (#342): the findings go to Problems, grouped by API, so
 * a lint again replaces only that API's rows.
 *
 * Shared by the `rest.lintDefinition` command and the explorer's menu, and run quietly after an
 * OpenAPI import and an applied definition update.
 */

import { showToast } from '../../components/toast.js';
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
    useUiStore.getState().showConsoleTab('problems');
    if (result.value.findings.length === 0) showToast('Lint found no problems.');
  }
}
