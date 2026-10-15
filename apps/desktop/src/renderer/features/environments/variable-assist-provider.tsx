import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type * as Monaco from 'monaco-editor';
import { VariableAssistContext, useVariableAssist, type VariableAssist } from '../../components/variable-field.js';
import { attachVariableAssist, type VariableAssistHandle } from '../../editor/variable-assist-monaco.js';
import { useProjectStore } from '../../state/project.js';
import { useRequestVariables } from '../../state/request-variables.js';
import { dataColumnsFor, useRunnerStore } from '../../state/runner.js';
import { SetVariableDialog } from './set-variable-dialog.js';
import { openVariableEditTarget } from './variable-edit-target.js';

/** A Set as Variable waiting on the dialog: the selection, and how to put the reference over it. */
interface Pending {
  readonly selected: string;
  readonly replace: ((reference: string) => void) | undefined;
}

/**
 * Gives every field and editor inside it variable help for `requestId` (#340): its variables, the
 * Set as Variable dialog, and the Edit links. Each protocol's request editor puts one around its tabs
 * and its response.
 */
export function VariableAssistProvider({
  requestId,
  children,
}: {
  readonly requestId: string | undefined;
  readonly children: ReactNode;
}) {
  const answered = useRequestVariables(requestId);
  // A Runner tab with a data file that runs this request adds its columns (#560).
  const runnerTargets = useRunnerStore((state) => state.targets);
  const variables = useMemo(() => {
    if (answered === undefined) return undefined;
    const dataColumns = dataColumnsFor(runnerTargets, requestId);
    return dataColumns.length === 0 ? answered : { ...answered, dataColumns };
  }, [answered, runnerTargets, requestId]);
  const projectId = useProjectStore((state) => (requestId === undefined ? undefined : state.projectOf[requestId]));
  const [pending, setPending] = useState<Pending>();
  const assist = useMemo<VariableAssist>(
    () => ({
      variables,
      setAsVariable: (selected, replace) => {
        setPending({ selected, replace });
      },
      openEdit: openVariableEditTarget,
    }),
    [variables],
  );
  return (
    <VariableAssistContext.Provider value={assist}>
      {children}
      <SetVariableDialog
        selected={pending?.selected}
        projectId={projectId}
        variables={variables}
        onClose={() => {
          setPending(undefined);
        }}
        onCreated={(reference) => {
          pending?.replace?.(reference);
        }}
      />
    </VariableAssistContext.Provider>
  );
}

/**
 * The `onMount` step that gives a Monaco editor the surrounding request's variable help: completion,
 * hover, the unresolved marks (refreshed when the variables change) and Set as Variable — which, in a
 * `readOnly` editor (a response), only creates the variable. Outside a request it does nothing.
 */
export function useEditorVariableAssist(
  options: { readonly readOnly?: boolean } = {},
): (editor: Monaco.editor.IStandaloneCodeEditor, monacoNS: unknown) => void {
  const assist = useVariableAssist();
  const assistRef = useRef(assist);
  assistRef.current = assist;
  const handle = useRef<VariableAssistHandle>(undefined);
  const readOnly = options.readOnly === true;

  useEffect(() => {
    handle.current?.refresh();
  }, [assist?.variables]);
  useEffect(
    () => () => {
      handle.current?.dispose();
      handle.current = undefined;
    },
    [],
  );

  return useCallback(
    (editor, monacoNS) => {
      if (assistRef.current === undefined) return;
      handle.current?.dispose();
      handle.current = attachVariableAssist(
        editor,
        monacoNS as typeof Monaco,
        {
          variables: () => assistRef.current?.variables,
          onSetAsVariable: (selected, replace) => {
            assistRef.current?.setAsVariable(selected, replace);
          },
        },
        { readOnly },
      );
    },
    [readOnly],
  );
}
