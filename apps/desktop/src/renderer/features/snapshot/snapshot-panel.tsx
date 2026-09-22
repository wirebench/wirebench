/**
 * The Snapshot tab of the SOAP and REST response panes: compares the response on screen with the
 * golden response saved beside the request, semantically for JSON and XML.
 *
 * The comparison runs here, in the renderer — the engine's snapshot diff is pure — and the tab
 * re-reads the golden whenever it mounts, a new response arrives or the request's project is
 * saved, which is how it notices that the project can now keep a snapshot.
 */
import { useEffect, useMemo, useState } from 'react';
import { detectSnapshotFormat, diffSnapshot, parseIgnoreRules, type SnapshotChange } from '@wirebench/engine/snapshot';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';
import { useSnapshotsStore } from '../../state/snapshots.js';
import type { SnapshotWire } from '../../../shared/wire-types.js';

/** Past this many UTF-8 bytes on either side, the tab does not attempt a semantic diff. */
export const MAX_SNAPSHOT_COMPARE_BYTES = 2 * 1024 * 1024;

const encoder = new TextEncoder();

function tooLarge(text: string): boolean {
  // A UTF-16 code unit is at most 3 UTF-8 bytes, so only a borderline string needs encoding.
  if (text.length > MAX_SNAPSHOT_COMPARE_BYTES) {
    return true;
  }
  return text.length * 3 > MAX_SNAPSHOT_COMPARE_BYTES && encoder.encode(text).length > MAX_SNAPSHOT_COMPARE_BYTES;
}

export interface SnapshotPanelProps {
  readonly requestId: string;
  /** The response body as text; `undefined` while there is no response. */
  readonly body: string | undefined;
  /** The response's `Content-Type`, used when the golden recorded none. */
  readonly contentType?: string;
  /** Set when the response body has no text form (an image or other binary body). */
  readonly binary?: boolean;
}

const NO_TEXT = 'This response has no text body to compare.';

/** The textarea's lines as the sidecar keeps them: trimmed, blanks dropped, comments kept. */
function ruleLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function Message({ children }: { readonly children: React.ReactNode }) {
  return <p className="p-3 text-sm text-fg-subtle">{children}</p>;
}

/** The Snapshot tab. */
export function SnapshotPanel({ requestId, body, contentType, binary = false }: SnapshotPanelProps) {
  const entry = useSnapshotsStore((store) => store.entries[requestId]);
  const failed = useSnapshotsStore((store) => store.failed[requestId] === true);
  const load = useSnapshotsStore((store) => store.load);
  const save = useSnapshotsStore((store) => store.save);
  // Changes on every save of the request's project, so a tab that said "Save the project…" reads
  // again once it has been.
  const lastSavedAt = useProjectStore((store) => {
    const projectId = store.projectOf[requestId];
    return projectId === undefined ? undefined : store.projects[projectId]?.lastSavedAt;
  });

  useEffect(() => {
    if (body !== undefined) {
      void load(requestId);
    }
  }, [requestId, body, load, lastSavedAt]);

  if (body === undefined) {
    return <Message>Send the request to compare its response.</Message>;
  }
  if (entry === undefined) {
    return <Message>{failed ? 'The snapshot could not be read.' : 'Loading…'}</Message>;
  }
  if (entry.status === 'unsaved') {
    return <Message>Save the project to keep a snapshot beside this request.</Message>;
  }
  if (entry.status === 'none') {
    return (
      <div data-testid="snapshot-panel" className="flex flex-col items-start gap-2 p-3 text-sm">
        <p className="text-fg-subtle">No snapshot saved.</p>
        {binary ? (
          <p className="text-fg-subtle">{NO_TEXT}</p>
        ) : (
          <Button variant="primary" onClick={() => void save(requestId, body, contentType, [])}>
            Save as snapshot
          </Button>
        )}
      </div>
    );
  }
  return (
    <SnapshotComparison
      requestId={requestId}
      body={body}
      contentType={contentType}
      binary={binary}
      golden={entry.snapshot}
    />
  );
}

interface ComparisonProps {
  readonly requestId: string;
  readonly body: string;
  readonly contentType: string | undefined;
  readonly binary: boolean;
  readonly golden: SnapshotWire;
}

function SnapshotComparison({ requestId, body, contentType, binary, golden }: ComparisonProps) {
  const save = useSnapshotsStore((store) => store.save);
  const setIgnore = useSnapshotsStore((store) => store.setIgnore);
  const addIgnoreRule = useSnapshotsStore((store) => store.addIgnoreRule);
  const remove = useSnapshotsStore((store) => store.remove);
  const [confirmUpdate, setConfirmUpdate] = useState(false);

  const savedRules = golden.ignore.join('\n');
  const [draft, setDraft] = useState(savedRules);
  useEffect(() => {
    setDraft(savedRules);
  }, [savedRules]);

  const diff = useMemo(() => {
    if (binary) {
      return 'binary' as const;
    }
    if (tooLarge(body) || tooLarge(golden.body)) {
      return 'too-large' as const;
    }
    const format = detectSnapshotFormat(golden.body, golden.contentType ?? contentType);
    return diffSnapshot(golden.body, body, { format, ignore: parseIgnoreRules(golden.ignore.join('\n')) });
  }, [binary, golden.body, golden.contentType, golden.ignore, contentType, body]);
  const comparable = typeof diff !== 'string';

  function ignorePath(path: string): void {
    // Read from the store at click time, not from this render, so it composes with a rule the
    // textarea's blur has just saved or an Ignore clicked a moment ago.
    void addIgnoreRule(requestId, path);
  }

  function compareSideBySide(): void {
    useEditorsStore.getState().openOrReplace({
      id: 'diff',
      kind: 'diff',
      title: 'Compare',
      diff: {
        leftLabel: `Snapshot (${new Date(golden.savedAt).toLocaleString()})`,
        rightLabel: 'Current response',
        leftXml: golden.body,
        rightXml: body,
      },
    });
  }

  return (
    <div data-testid="snapshot-panel" className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {!binary && <Button onClick={() => setConfirmUpdate(true)}>Update snapshot</Button>}
        <Button onClick={compareSideBySide}>Compare side by side</Button>
        <Button variant="ghost" onClick={() => void remove(requestId)}>
          Delete snapshot
        </Button>
      </div>

      {diff === 'binary' ? (
        <p role="status" className="text-fg-subtle">
          {NO_TEXT}
        </p>
      ) : diff === 'too-large' ? (
        <p role="status" className="text-fg-subtle">
          Too large to compare semantically
        </p>
      ) : diff.changes.length === 0 ? (
        <p role="status" data-testid="snapshot-status" className="text-fg-default">
          {diff.ignored > 0 ? `Matches the snapshot (${String(diff.ignored)} ignored)` : 'Matches the snapshot'}
        </p>
      ) : (
        <>
          <p role="status" data-testid="snapshot-status" className="text-fg-default">
            {diff.changes.length === 1 ? '1 difference' : `${String(diff.changes.length)} differences`}
            {diff.ignored > 0 ? ` (${String(diff.ignored)} ignored)` : ''}
          </p>
          {diff.error !== undefined && <p className="text-xs text-fg-subtle">{`Compared as text: ${diff.error}`}</p>}
          <ChangesTable changes={diff.changes} onIgnore={ignorePath} />
        </>
      )}

      {comparable && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-subtle">Ignore rules</span>
          <textarea
            value={draft}
            rows={4}
            spellCheck={false}
            placeholder="One path per line; // matches at any depth; # starts a comment"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              const lines = ruleLines(draft);
              if (lines.join('\n') !== savedRules) {
                void setIgnore(requestId, lines);
              }
            }}
            className="rounded-md border border-hairline-strong bg-surface-raised p-2 font-mono text-xs text-fg-default"
          />
        </label>
      )}

      <ConfirmDialog
        open={confirmUpdate}
        onOpenChange={setConfirmUpdate}
        title="Update snapshot?"
        description="The saved snapshot is replaced by the current response. Its ignore rules are kept."
        confirmLabel="Update"
        onConfirm={() => {
          setConfirmUpdate(false);
          void save(requestId, body, contentType ?? golden.contentType, golden.ignore);
        }}
      />
    </div>
  );
}

function ChangesTable({
  changes,
  onIgnore,
}: {
  readonly changes: readonly SnapshotChange[];
  readonly onIgnore: (path: string) => void;
}) {
  return (
    <table aria-label="Snapshot differences" className="w-full border-collapse text-left font-mono text-xs">
      <thead className="text-fg-subtle">
        <tr>
          <th scope="col" className="px-2 py-1 font-normal">
            Kind
          </th>
          <th scope="col" className="px-2 py-1 font-normal">
            Path
          </th>
          <th scope="col" className="px-2 py-1 font-normal">
            Expected → actual
          </th>
          <th scope="col" className="px-2 py-1 font-normal">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {changes.map((change, index) => (
          <tr key={`${change.path}:${String(index)}`} className="border-t border-hairline align-top">
            <td className="px-2 py-1 text-fg-muted">{change.kind}</td>
            <td className="px-2 py-1 break-all text-fg-default">{change.path}</td>
            <td className="px-2 py-1 break-all text-fg-default">
              {`${change.expected ?? '—'} → ${change.actual ?? '—'}`}
            </td>
            <td className="px-2 py-1 text-right">
              <Button variant="ghost" aria-label={`Ignore ${change.path}`} onClick={() => onIgnore(change.path)}>
                Ignore
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
