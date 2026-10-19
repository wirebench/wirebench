/**
 * **Convert scripts…**: the review of turning imported scripts into Wirebench scripts. One row per
 * level whose scripts are still in the source client's dialect, ticked by default, with its TODO
 * count; the selected row shows each phase before and after, with the checker's problems under it.
 * **Accept** converts the ticked rows in one project edit; the dialog then reports each level converted,
 * with its backups and TODO count, and each refused one and why, and a toast sums it up. **Cancel**
 * changes nothing.
 */
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Suspense, lazy, useEffect, useRef } from 'react';
import { create } from 'zustand';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { useProjectStore } from '../../state/project.js';
import type {
  ConversionRefusalWire,
  ScriptConversionWire,
  ScriptConversionsResultWire,
} from '../../../shared/wire-base.js';

// Split out so Monaco loads with the review, never before the first paint.
const ConvertScriptsDiff = lazy(async () => {
  const module = await import('./convert-scripts-diff.js');
  return { default: module.ConvertScriptsDiff };
});

const DIALECT_LABELS: Readonly<Record<ScriptConversionWire['dialect'], string>> = {
  postman: 'Postman',
  insomnia: 'Insomnia',
  bruno: 'Bruno',
  hoppscotch: 'Hoppscotch',
  'thunder-client': 'Thunder Client',
};

/** Why Accept left a level as it was, as the report says it. */
const REFUSAL_TEXT: Readonly<Record<ConversionRefusalWire, string>> = {
  changed: 'changed since the review opened',
  'not-layered': 'already converted',
  syntax: 'does not convert',
  'duplicate-id': 'another level has the same id',
};

/** What Accept says when main refuses because the project has unsaved edits. */
const SAVE_FIRST = 'Save the project first, then convert its scripts.';

interface ConvertScriptsDialogState {
  /** What the review was opened on, while it is open: a project, or one level and those beneath it. */
  readonly target: { readonly projectId: string; readonly ownerId?: string } | undefined;
  /** The levels proposed; `undefined` while the proposal is being worked out. */
  readonly levels: readonly ScriptConversionWire[] | undefined;
  /** Per row of `levels`, whether Accept converts it. A row that does not convert is never ticked. */
  readonly ticked: readonly boolean[];
  /** The row whose diff is shown. */
  readonly selected: number;
  /** An Accept is in flight — this review's, or one sent from a review closed since. */
  readonly busy: boolean;
  /** What Accept did, once it did it: the dialog shows it in place of the review. */
  readonly report: ScriptConversionsResultWire | undefined;
  /** Why the proposal or the Accept failed, shown in the dialog. */
  readonly error: string | undefined;
  /**
   * Opens the review over a whole project, or over `ownerId` (a request, folder, API or interface)
   * and the levels beneath it. Resolves once the proposal is shown.
   */
  readonly open: (projectId: string, ownerId?: string) => Promise<void>;
  readonly toggle: (row: number, ticked: boolean) => void;
  readonly select: (row: number) => void;
  /** Converts the ticked rows and shows the report, or stays on the review saying why it could not. */
  readonly accept: () => Promise<void>;
  readonly close: () => void;
}

const CLOSED = {
  target: undefined,
  levels: undefined,
  ticked: [],
  selected: 0,
  busy: false,
  report: undefined,
  error: undefined,
} as const;

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return (error as Error & { code?: unknown }).code === 'project-dirty' ? SAVE_FIRST : error.message;
  }
  return fallback;
}

export const useConvertScriptsDialog = create<ConvertScriptsDialogState>((set, get) => {
  /** Bumped on every open and close, so a proposal that lands after either is dropped. */
  let generation = 0;
  /**
   * Whether a `convert-scripts` edit is on its way to main. Not reset by `open` or `close`: a review
   * opened while one is in flight must not send a second edit before the first one lands.
   */
  let inFlight = false;

  return {
    ...CLOSED,

    open: async (projectId, ownerId) => {
      const opened = ++generation;
      set({ ...CLOSED, busy: inFlight, target: { projectId, ...(ownerId === undefined ? {} : { ownerId }) } });
      try {
        const levels = await useProjectStore.getState().proposeConversions(projectId, ownerId);
        if (opened === generation) {
          set({ levels, ticked: levels.map((level) => level.result.ok) });
        }
      } catch (error) {
        if (opened === generation) {
          set({ levels: [], error: messageOf(error, 'Could not work out the conversion') });
        }
      }
    },

    toggle: (row, ticked) => {
      const { levels, ticked: before } = get();
      if (levels?.[row]?.result.ok !== true) {
        return;
      }
      set({ ticked: before.map((value, index) => (index === row ? ticked : value)) });
    },

    select: (row) => {
      set({ selected: row });
    },

    accept: async () => {
      const { target, levels, ticked, report } = get();
      if (target === undefined || levels === undefined || report !== undefined || inFlight) {
        return;
      }
      const chosen = levels.filter((level, index) => ticked[index] === true && level.result.ok);
      if (chosen.length === 0) {
        return;
      }
      const accepted = generation;
      inFlight = true;
      set({ busy: true, error: undefined });
      try {
        const result = await useProjectStore.getState().convertScripts(
          target.projectId,
          chosen.map(({ ownerId, fingerprint }) => ({ ownerId, fingerprint })),
        );
        inFlight = false;
        set(accepted === generation ? { busy: false, report: result } : { busy: false });
        showToast(convertResultMessage(result));
      } catch (error) {
        inFlight = false;
        set(
          accepted === generation
            ? { busy: false, error: messageOf(error, 'Could not convert the scripts') }
            : { busy: false },
        );
      }
    },

    close: () => {
      generation += 1;
      set(CLOSED);
    },
  };
});

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `one ${one}` : `${String(count)} ${many}`;
}

/** A refused level's path as the report names it. */
function refusedName(path: readonly string[]): string {
  return path.length === 0 ? 'A level no longer there' : path.join(' / ');
}

/** What the toast after Accept says: the levels converted, in sum, and how many were not. */
export function convertResultMessage(result: ScriptConversionsResultWire): string {
  const { applied, refused } = result;
  const backups = applied.reduce((sum, level) => sum + level.backups.length, 0);
  const todos = applied.reduce((sum, level) => sum + level.todos, 0);
  const done =
    applied.length === 0
      ? 'No level was converted.'
      : `Converted ${plural(applied.length, 'level', 'levels')}: ${plural(backups, 'backup', 'backups')} in imported-scripts/, ${
          todos === 0 ? 'no TODOs' : plural(todos, 'TODO', 'TODOs')
        } to check.`;
  if (refused.length === 0) {
    return done;
  }
  const count = plural(refused.length, 'level', 'levels');
  return `${done} ${count.charAt(0).toUpperCase()}${count.slice(1)} not converted.`;
}

/** What a row says about the calls left as written: those not converted yet apart from those no mapping can convert. */
function todoText(level: ScriptConversionWire): string {
  const { result } = level;
  if (!result.ok) {
    return result.line === undefined ? result.message : `has a syntax error at line ${String(result.line)}`;
  }
  const { unsupported, notMapped, shadowed } = result.todoCounts;
  const later = notMapped + shadowed;
  const parts = [
    ...(later > 0 ? [`${String(later)} not converted yet`] : []),
    ...(unsupported > 0 ? [`${String(unsupported)} unsupported`] : []),
  ];
  return parts.length === 0 ? 'No TODOs' : parts.join(', ');
}

function Row({ level, row }: { readonly level: ScriptConversionWire; readonly row: number }) {
  const ticked = useConvertScriptsDialog((state) => state.ticked[row] ?? false);
  const selected = useConvertScriptsDialog((state) => state.selected === row);
  const busy = useConvertScriptsDialog((state) => state.busy);
  const toggle = useConvertScriptsDialog((state) => state.toggle);
  const select = useConvertScriptsDialog((state) => state.select);
  const path = level.path.join(' / ');
  const failed = !level.result.ok;
  const statusId = `convert-scripts-row-${String(row)}-status`;

  return (
    <li
      data-testid="convert-scripts-row"
      className={`flex items-start gap-2 rounded px-2 py-1.5 ${selected ? 'bg-surface-hover' : ''}`}
    >
      <input
        type="checkbox"
        className="mt-0.5"
        aria-label={`Convert ${path}`}
        aria-describedby={statusId}
        checked={ticked}
        disabled={failed || busy}
        onChange={(event) => {
          toggle(row, event.target.checked);
        }}
      />
      <button
        type="button"
        aria-current={selected}
        className="min-w-0 flex-1 text-left"
        onClick={() => {
          select(row);
        }}
      >
        <span className="block truncate text-sm text-fg-default" title={path}>
          {path}
        </span>
        <span id={statusId} className={`block text-xs ${failed ? 'text-status-danger' : 'text-fg-subtle'}`}>
          {`${DIALECT_LABELS[level.dialect]} · ${todoText(level)}`}
        </span>
      </button>
    </li>
  );
}

/** What Accept did, level by level (spec §7), with Close as its one way out. */
function Report({ report }: { readonly report: ScriptConversionsResultWire }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // The review's buttons are gone, and focus with them: it goes to Close.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  const { applied, refused } = report;

  return (
    <>
      <AlertDialog.Title className="text-md font-medium text-fg-default">
        {applied.length === 0 ? 'No scripts converted' : 'Scripts converted'}
      </AlertDialog.Title>
      <AlertDialog.Description asChild>
        <div className="mt-1 text-sm text-fg-subtle">
          {applied.length === 0
            ? 'Every level was left as it was.'
            : 'Each level below has a typed script now, and its imported text is kept in the backups listed.'}
        </div>
      </AlertDialog.Description>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
        {applied.length > 0 && (
          <section aria-label="Converted">
            <h3 className="text-sm font-medium text-fg-default">Converted</h3>
            <ul data-testid="convert-scripts-report-applied" className="mt-1 flex flex-col gap-2">
              {applied.map((level, index) => (
                <li key={`${level.ownerId}:${String(index)}`} className="text-sm">
                  <span className="block text-fg-default">{level.path.join(' / ')}</span>
                  <span className="block text-xs text-fg-subtle">
                    {level.todos === 0 ? 'No TODOs' : plural(level.todos, 'TODO', 'TODOs')}
                  </span>
                  <ul aria-label="Backups" className="mt-0.5 font-mono text-xs text-fg-subtle">
                    {level.backups.map((backup) => (
                      <li key={backup}>{backup}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        )}
        {refused.length > 0 && (
          <section aria-label="Not converted" className="mt-3">
            <h3 className="text-sm font-medium text-fg-default">Not converted</h3>
            <ul data-testid="convert-scripts-report-refused" className="mt-1 flex flex-col gap-1 text-sm">
              {refused.map((level, index) => (
                <li key={`${level.ownerId}:${String(index)}`} className="text-fg-default">
                  {`${refusedName(level.path)}: ${REFUSAL_TEXT[level.reason]}`}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <div className="mt-4 flex justify-end">
        <AlertDialog.Cancel asChild>
          <Button ref={closeRef} variant="primary" data-testid="convert-scripts-close">
            Close
          </Button>
        </AlertDialog.Cancel>
      </div>
    </>
  );
}

/** The review. Mounted once, with the explorer, beside **Switch on scripts…**. */
export function ConvertScriptsDialog() {
  const target = useConvertScriptsDialog((state) => state.target);
  const levels = useConvertScriptsDialog((state) => state.levels);
  const ticked = useConvertScriptsDialog((state) => state.ticked);
  const selected = useConvertScriptsDialog((state) => state.selected);
  const busy = useConvertScriptsDialog((state) => state.busy);
  const report = useConvertScriptsDialog((state) => state.report);
  const error = useConvertScriptsDialog((state) => state.error);
  const accept = useConvertScriptsDialog((state) => state.accept);
  const close = useConvertScriptsDialog((state) => state.close);

  const count = ticked.filter(Boolean).length;
  const shown = levels?.[selected];

  return (
    <AlertDialog.Root
      open={target !== undefined}
      onOpenChange={(open) => {
        // While this review's Accept is in flight it cannot be dismissed; the report closes freely.
        if (!open && (report !== undefined || !busy)) {
          close();
        }
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/40" />
        <AlertDialog.Content
          data-testid="convert-scripts-dialog"
          className="fixed top-1/2 left-1/2 flex h-[85vh] w-[64rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface-raised p-4 shadow-lg"
        >
          {report !== undefined ? (
            <Report report={report} />
          ) : (
            <>
              <AlertDialog.Title className="text-md font-medium text-fg-default">
                Convert to Wirebench scripts?
              </AlertDialog.Title>
              <AlertDialog.Description asChild>
                <div className="mt-1 text-sm text-fg-subtle">
                  Each ticked level gets a typed script in place of its imported one. The imported text is kept in
                  imported-scripts/, and nothing is switched on. Calls left as written are marked with a TODO.
                </div>
              </AlertDialog.Description>
              {levels === undefined ? (
                <p className="mt-3 text-sm text-fg-subtle">Working out the conversion…</p>
              ) : levels.length === 0 ? (
                error === undefined && (
                  <p className="mt-3 text-sm text-fg-subtle">No imported scripts to convert here.</p>
                )
              ) : (
                <div className="mt-3 flex min-h-0 flex-1 gap-3">
                  <ul aria-label="Levels" className="w-72 shrink-0 overflow-y-auto border-r border-hairline pr-2">
                    {levels.map((level, row) => (
                      <Row key={`${level.ownerId}:${String(row)}`} level={level} row={row} />
                    ))}
                  </ul>
                  <div className="min-w-0 flex-1 overflow-y-auto">
                    {shown !== undefined && !shown.result.ok ? (
                      <p className="text-sm text-status-danger">{`This level does not convert: ${shown.result.message}`}</p>
                    ) : (
                      shown !== undefined && (
                        <Suspense fallback={<span className="text-sm text-fg-subtle">Loading editor…</span>}>
                          <ConvertScriptsDiff level={shown} />
                        </Suspense>
                      )
                    )}
                  </div>
                </div>
              )}
              {error !== undefined && (
                <p role="alert" className="mt-2 text-sm text-status-danger">
                  {error}
                </p>
              )}
              <div className="mt-4 flex items-center gap-2">
                <span className="flex-1 text-xs text-fg-subtle">
                  {levels !== undefined && levels.length > 0 && plural(count, 'level ticked', 'levels ticked')}
                </span>
                <AlertDialog.Cancel asChild>
                  <Button data-testid="convert-scripts-cancel" disabled={busy}>
                    Cancel
                  </Button>
                </AlertDialog.Cancel>
                <Button
                  variant="primary"
                  data-testid="convert-scripts-accept"
                  disabled={busy || count === 0}
                  onClick={() => {
                    void accept();
                  }}
                >
                  Accept
                </Button>
              </div>
            </>
          )}
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
