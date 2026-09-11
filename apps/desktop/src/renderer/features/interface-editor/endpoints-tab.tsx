/**
 * The Interface editor's Endpoints tab: every addressable endpoint of the interface with its
 * default flag and credentials summary. Add/Edit/Remove all go through the existing
 * `EndpointsDialog`, so there is exactly one place that mutates endpoints.
 */

import { useState } from 'react';
import { Button } from '../../components/button.js';
import { useProjectStore } from '../../state/project.js';
import { EndpointsDialog } from '../request-editor/endpoints-dialog.js';

export interface EndpointsTabProps {
  readonly interfaceId: string;
}

const CELL = 'px-2 py-1 text-left align-top';

export function EndpointsTab({ interfaceId }: EndpointsTabProps) {
  const iface = useProjectStore((state) => state.interfaces[interfaceId]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const endpoints = iface?.endpoints ?? [];

  return (
    <div data-testid="interface-endpoints" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-end gap-2 border-b border-hairline p-2">
        <Button variant="primary" onClick={() => setDialogOpen(true)}>
          Edit endpoints…
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {endpoints.length === 0 ? (
          <p className="p-4 text-md text-fg-muted">This interface declares no endpoints.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-fg-subtle">
              <tr className="border-b border-hairline">
                <th className={CELL}>Name</th>
                <th className={CELL}>URL</th>
                <th className={CELL}>Default</th>
                <th className={CELL}>Auth</th>
                <th className={CELL}>Auth mode</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((endpoint) => (
                <tr key={endpoint.id} data-testid="interface-endpoint-row" className="border-b border-hairline">
                  <td className={`${CELL} text-fg-default`}>{endpoint.name}</td>
                  <td className={`${CELL} font-mono text-fg-muted`}>{endpoint.url}</td>
                  <td className={CELL}>
                    {iface?.defaultEndpointId === endpoint.id ? (
                      <span data-testid="interface-endpoint-default" className="text-accent">
                        Default
                      </span>
                    ) : (
                      <span className="text-fg-faint">—</span>
                    )}
                  </td>
                  <td className={`${CELL} text-fg-muted`}>{endpoint.auth?.type ?? 'none'}</td>
                  <td className={`${CELL} text-fg-muted`}>{endpoint.authMode}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <EndpointsDialog open={dialogOpen} onOpenChange={setDialogOpen} interfaceId={interfaceId} />
    </div>
  );
}
