/**
 * The Catalogue section of an MCP server's tab (#79): what the server listed at the last refresh —
 * its tools, resources, resource templates and prompts — where that came from, and *Refresh*. A tool
 * row offers *New request*, which makes a `tools/call` for it and opens it.
 *
 * A refresh of a stdio server this machine has not approved asks first, in main, as a send does; the
 * button stays busy until that answer and the fetch are done. A failure is shown under the button.
 */
import { useState } from 'react';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { SettingsGroup } from '../../components/settings-grid.js';
import { useProjectStore } from '../../state/project.js';
import { refreshSummary } from '../explorer/explorer-actions.js';
import { newMcpRequestFromTool } from './mcp-api-actions.js';
import type { McpCatalogueInfoWire, McpCatalogueWire } from '../../../shared/kinds/mcp/wire.js';

export interface CatalogueSectionProps {
  readonly apiId: string;
  readonly name: string;
  readonly info: McpCatalogueInfoWire | undefined;
  readonly catalogue: McpCatalogueWire | undefined;
}

/** "Fetched <date> from <server> <version>", the date in this machine's format. */
export function fetchedLine(info: McpCatalogueInfoWire): string {
  const date = new Date(info.fetchedAt);
  const when = Number.isNaN(date.getTime()) ? info.fetchedAt : date.toLocaleString();
  return `Fetched ${when} from ${info.serverInfo.name} ${info.serverInfo.version}`;
}

/** One row of a list: its name (or title, with the name beside it) and its description. */
interface Entry {
  readonly key: string;
  readonly label: string;
  readonly detail?: string | undefined;
  readonly description?: string | undefined;
}

export function CatalogueSection({ apiId, name, info, catalogue }: CatalogueSectionProps) {
  const refreshMcpCatalogue = useProjectStore((state) => state.refreshMcpCatalogue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = (): void => {
    setBusy(true);
    setError(undefined);
    refreshMcpCatalogue(apiId)
      .then((refreshed) => {
        showToast(refreshSummary(name, refreshed.counts, refreshed.warnings));
      })
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : 'Refresh catalogue failed');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const tools: Entry[] = (catalogue?.tools ?? []).map((tool) => ({
    key: tool.name,
    label: tool.title ?? tool.name,
    detail: tool.title === undefined ? undefined : tool.name,
    description: tool.description,
  }));
  const resources: Entry[] = (catalogue?.resources ?? []).map((resource) => ({
    key: resource.uri,
    label: resource.title ?? resource.name,
    detail: resource.uri,
    description: resource.description,
  }));
  const templates: Entry[] = (catalogue?.resourceTemplates ?? []).map((template) => ({
    key: template.uriTemplate,
    label: template.title ?? template.name,
    detail: template.uriTemplate,
    description: template.description,
  }));
  const prompts: Entry[] = (catalogue?.prompts ?? []).map((prompt) => ({
    key: prompt.name,
    label: prompt.title ?? prompt.name,
    detail: prompt.title === undefined ? undefined : prompt.name,
    description: prompt.description,
  }));

  return (
    <SettingsGroup title="Catalogue" hint="What the server listed at the last refresh, kept in the project.">
      <div className="flex items-center gap-3 py-1">
        <Button data-testid="mcp-api-refresh" disabled={busy} aria-busy={busy} onClick={refresh}>
          {busy ? 'Refreshing…' : 'Refresh'}
        </Button>
        <p data-testid="mcp-api-fetched" className="truncate text-sm text-fg-subtle">
          {info === undefined ? 'Not fetched yet.' : fetchedLine(info)}
        </p>
      </div>
      {error !== undefined && (
        <p role="alert" data-testid="mcp-api-refresh-error" className="py-1 text-sm text-status-danger">
          {error}
        </p>
      )}
      {catalogue !== undefined && (
        <div className="mt-2 flex flex-col gap-3">
          <CatalogueList
            title="Tools"
            testId="mcp-api-tools"
            entries={tools}
            action={(entry) => (
              <Button
                variant="ghost"
                aria-label={`New request for ${entry.key}`}
                data-testid="mcp-api-tool-new-request"
                onClick={() => {
                  newMcpRequestFromTool(apiId, entry.key);
                }}
              >
                New request
              </Button>
            )}
          />
          <CatalogueList title="Resources" testId="mcp-api-resources" entries={resources} />
          <CatalogueList title="Resource templates" testId="mcp-api-templates" entries={templates} />
          <CatalogueList title="Prompts" testId="mcp-api-prompts" entries={prompts} />
        </div>
      )}
    </SettingsGroup>
  );
}

function CatalogueList({
  title,
  testId,
  entries,
  action,
}: {
  readonly title: string;
  readonly testId: string;
  readonly entries: readonly Entry[];
  readonly action?: (entry: Entry) => React.ReactNode;
}) {
  return (
    <section aria-label={title} data-testid={testId}>
      <h4 className="mb-1 text-sm font-medium text-fg-default">
        {title} <span className="text-fg-subtle">({entries.length})</span>
      </h4>
      {entries.length === 0 ? (
        <p className="text-sm text-fg-subtle">None.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-hairline rounded-md border border-hairline">
          {entries.map((entry) => (
            <li key={entry.key} data-testid={`${testId}-row`} className="flex items-start gap-2 px-2 py-1">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-fg-default">
                  {entry.label}
                  {entry.detail !== undefined && (
                    <span className="ml-2 font-mono text-xs text-fg-subtle">{entry.detail}</span>
                  )}
                </span>
                {entry.description !== undefined && (
                  <span className="line-clamp-2 text-xs text-fg-subtle">{entry.description}</span>
                )}
              </div>
              {action?.(entry)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
