import { useEffect, useState } from 'react';
import type { RequestVariablesResponse } from '../../shared/wire-base.js';
import { useCurrentValuesStore } from './current-values.js';
import { useGlobalsStore } from './globals.js';
import { ipc } from './ipc-client.js';
import { useProjectStore } from './project.js';
import { useWorkspaceStore } from './workspace.js';

/**
 * The variables one request can reference (#340), as main resolves them for its send
 * (`request.variables`): for completion, hover and the unresolved marks.
 *
 * Asked again whenever something they come from changes — a project (its properties and
 * environments), the workspace (its variables, environments and the active one), globals or the
 * session's current values. `undefined` until the first answer arrives, and while there is no
 * request: nothing is marked unresolved on a guess.
 */
export function useRequestVariables(requestId: string | undefined): RequestVariablesResponse | undefined {
  const projects = useProjectStore((state) => state.projects);
  const workspace = useWorkspaceStore((state) => state.workspace);
  const globals = useGlobalsStore((state) => state.properties);
  const globalsDisabled = useGlobalsStore((state) => state.disabled);
  const current = useCurrentValuesStore((state) => state.byScope);
  const [answer, setAnswer] = useState<{ readonly requestId: string; readonly value: RequestVariablesResponse }>();

  useEffect(() => {
    if (requestId === undefined) return undefined;
    let live = true;
    void ipc()
      .request.variables({ requestId })
      .then((result) => {
        if (live && result.ok) setAnswer({ requestId, value: result.value });
      });
    return () => {
      live = false;
    };
  }, [requestId, projects, workspace, globals, globalsDisabled, current]);

  return answer !== undefined && answer.requestId === requestId ? answer.value : undefined;
}
