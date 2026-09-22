/**
 * The WebSocket API tab's Definition card, for an API imported from an AsyncAPI document: where the
 * contract came from, whether a copy was cached, and *Update definition*, which re-reads that source
 * and shows what it would change before anything is applied.
 */
import { useState } from 'react';
import { Button } from '../../components/button.js';
import { ReadOnlySetting } from '../../components/settings-grid.js';
import type { WsApiWire } from '../../../shared/wire-types.js';
import { AsyncApiUpdateDialog } from './asyncapi-update-dialog.js';

export interface AsyncApiDefinitionCardProps {
  readonly apiId: string;
  readonly definition: NonNullable<WsApiWire['definition']>;
}

/** One AsyncAPI-imported API's contract. */
export function AsyncApiDefinitionCard({ apiId, definition }: AsyncApiDefinitionCardProps) {
  const [updating, setUpdating] = useState(false);
  return (
    <div data-testid="asyncapi-definition-card" className="flex flex-col gap-1">
      <ReadOnlySetting label="Source" value={definition.source} testId="asyncapi-definition-source" />
      <ReadOnlySetting label="Format" value="AsyncAPI" />
      <ReadOnlySetting label="Cached" value={definition.cache ? 'yes' : 'no'} />
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          variant="secondary"
          data-testid="asyncapi-definition-update"
          onClick={() => {
            setUpdating(true);
          }}
        >
          Update definition…
        </Button>
      </div>
      <p className="text-xs text-fg-subtle">
        The source is read again and the change is shown before it is applied. Nothing is deleted: a request whose
        channel is gone is kept, badged orphaned.
      </p>
      {updating && <AsyncApiUpdateDialog apiId={apiId} open={updating} onOpenChange={setUpdating} />}
    </div>
  );
}
