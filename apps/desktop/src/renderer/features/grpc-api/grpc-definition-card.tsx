/**
 * The gRPC API tab's Definition card, which has two forms because a gRPC schema has two origins.
 *
 * An API imported from `.proto` files shows the same card a REST API's specification does: the
 * files are on disk, byte-exact, and can be read and exported. An API discovered from a running
 * server has no `.proto` text — what the server sent is the compiler's own output — so instead of a
 * viewer it offers the thing that only a discovered API can do: ask the server again.
 *
 * A refresh never deletes anything. A method the server no longer declares keeps its request,
 * badged orphaned in the explorer; one it has gained gets a request of its own.
 */
import { useState } from 'react';
import { Button } from '../../components/button.js';
import { ReadOnlySetting } from '../../components/settings-grid.js';
import { showToast } from '../../components/toast.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import { ApiDefinitionCard } from '../rest-api/api-definition-card.js';
import type { GrpcApiWire, GrpcReflectionVersionWire } from '../../../shared/wire-types.js';

export interface GrpcDefinitionCardProps {
  readonly apiId: string;
  readonly definition: NonNullable<GrpcApiWire['definition']>;
}

/** What one refresh changed, as a sentence the card keeps until the next one. */
function outcome(counts: {
  readonly requestsAdded: number;
  readonly requestsOrphaned: number;
  readonly requestsRestored: number;
}): string {
  const parts = [
    counts.requestsAdded > 0 ? `${String(counts.requestsAdded)} added` : undefined,
    counts.requestsOrphaned > 0 ? `${String(counts.requestsOrphaned)} orphaned` : undefined,
    counts.requestsRestored > 0 ? `${String(counts.requestsRestored)} back` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? 'Nothing changed.' : `Requests: ${parts.join(', ')}.`;
}

/** One gRPC API's definition: imported files to read, or a server to ask again. */
export function GrpcDefinitionCard({ apiId, definition }: GrpcDefinitionCardProps) {
  const refresh = useProjectStore((state) => state.refreshGrpcDefinition);
  const [version, setVersion] = useState<GrpcReflectionVersionWire>(definition.reflectionVersion ?? 'auto');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [changed, setChanged] = useState<string | undefined>(undefined);

  if (definition.kind !== 'reflection') {
    return <ApiDefinitionCard apiId={apiId} definition={definition} noun="file" />;
  }

  async function onRefresh(): Promise<void> {
    setRunning(true);
    setError(undefined);
    setChanged(undefined);
    try {
      const result = await refresh({ apiId, version });
      setChanged(outcome(result));
      showToast(`Discovered ${String(result.summary.methods)} methods from ${result.summary.target}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The server could not be asked');
    } finally {
      setRunning(false);
    }
  }

  async function onExport(): Promise<void> {
    const result = await ipc().api.exportDefinition({ apiId });
    if (!result.ok) {
      showToast(result.error.message);
      return;
    }
    if (!result.value.cancelled) {
      showToast('Exported the descriptor set.');
    }
  }

  return (
    <div data-testid="grpc-definition-card" className="flex flex-col gap-1">
      <ReadOnlySetting label="Source" value={definition.source} testId="api-definition-source" />
      <ReadOnlySetting label="Origin" value="server reflection" />
      <ReadOnlySetting label="Cached" value={definition.cache ? 'yes' : 'no'} />
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <label className="text-sm text-fg-subtle" htmlFor="grpc-definition-version">
          Ask with
        </label>
        <select
          id="grpc-definition-version"
          data-testid="grpc-definition-version"
          value={version}
          onChange={(event) => setVersion(event.target.value as GrpcReflectionVersionWire)}
          className="h-row rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
        >
          <option value="auto">Automatic (v1, then v1alpha)</option>
          <option value="v1">v1</option>
          <option value="v1alpha">v1alpha</option>
        </select>
        <Button
          variant="secondary"
          data-testid="grpc-definition-refresh"
          disabled={running}
          onClick={() => void onRefresh()}
        >
          {running ? 'Asking…' : 'Refresh from server'}
        </Button>
        {definition.cache && (
          <Button variant="secondary" data-testid="api-definition-export" onClick={() => void onExport()}>
            Export…
          </Button>
        )}
      </div>
      <p className="text-xs text-fg-subtle">
        The server is asked again at the API’s target. Nothing is deleted: a method it no longer declares keeps its
        request, badged orphaned.
      </p>
      {changed !== undefined && (
        <p data-testid="grpc-definition-changed" className="text-sm text-fg-default">
          {changed}
        </p>
      )}
      {error !== undefined && (
        <p role="alert" data-testid="grpc-definition-error" className="text-sm text-status-danger">
          {error}
        </p>
      )}
    </div>
  );
}
