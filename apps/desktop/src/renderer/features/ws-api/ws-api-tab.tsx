/**
 * The WebSocket API tab: what an API is, where it points, and what every request in it sends
 * before its own headers.
 *
 * The URL is the field that needs care, for the same reason a REST API's base URL does: an
 * environment can override it (under the API's slug, the same slot a REST base URL uses), and
 * when one does the override is where requests connect. The row shows both.
 */
import { AuthFields } from '../../components/auth-fields.js';
import { PagePath } from '../explorer/page-path.js';
import { SettingsPageTabs } from '../../components/settings-page-tabs.js';
import { KvTable } from '../../components/kv-table.js';
import { SettingsGroup, TextSetting } from '../../components/settings-grid.js';
import { OAuth2StatusPanel } from '../rest-editor/oauth2-status.js';
import { effectiveBaseUrl } from '../rest-api/api-tab.js';
import { useProjectStore } from '../../state/project.js';
import { useActiveEnvironment } from '../../state/workspace.js';
import type { AuthConfigWire } from '@shared/wire-base.js';
import { AsyncApiDefinitionCard } from './asyncapi-definition-card.js';

export interface WsApiTabProps {
  readonly apiId: string;
}

/** How each override source reads beside the field. */
const SOURCE_LABEL = {
  environment: 'this project’s environment',
  'workspace-environment': 'the workspace environment',
} as const;

/** One WebSocket API's page. */
export function WsApiTab({ apiId }: WsApiTabProps) {
  const api = useProjectStore((state) => state.wsApis[apiId]);
  const projectId = useProjectStore((state) => state.projectOf[apiId]);
  const project = useProjectStore((state) => (projectId === undefined ? undefined : state.projects[projectId]));
  const updateWsApi = useProjectStore((state) => state.updateWsApi);
  // The API's own project's active workspace environment (#468), whichever project is current.
  const workspaceEnvironment = useActiveEnvironment(projectId);

  if (api === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This API is no longer in the project.</p>;
  }

  const projectEnvironment = project?.environments.find((candidate) => candidate.id === project.activeEnvironmentId);
  const effective = effectiveBaseUrl({
    api: { slug: api.slug, baseUrl: api.url },
    projectOverride: projectEnvironment?.endpoints[api.slug],
    workspaceOverride: workspaceEnvironment?.endpoints[api.slug],
  });

  const patch = (changes: Parameters<typeof updateWsApi>[1]): void => {
    void updateWsApi(apiId, changes);
  };

  return (
    <section aria-label={`WebSocket API ${api.name}`} data-testid="ws-api-tab" className="h-full min-h-0">
      <SettingsPageTabs
        pageId={apiId}
        label="WebSocket API settings"
        header={<PagePath apiId={apiId} />}
        tabs={[
          {
            id: 'general',
            label: 'General',
            content: (
              <SettingsGroup>
                <TextSetting
                  label="Name"
                  testId="ws-api-name"
                  value={api.name}
                  onCommit={(name) => {
                    if (name.trim().length > 0) {
                      patch({ name: name.trim() });
                    }
                  }}
                />
                <TextSetting
                  label="Description"
                  testId="ws-api-description"
                  value={api.description ?? ''}
                  onCommit={(description) => {
                    patch({ description: description === '' ? null : description });
                  }}
                />
                {/* Top-aligned, the label kept to the input's height: the line under the input must not pull it down. */}
                <div className="flex items-start gap-2 py-0.5">
                  <label
                    htmlFor="ws-api-url"
                    className="flex h-row w-44 shrink-0 items-center truncate text-sm text-fg-muted"
                  >
                    URL
                  </label>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <input
                      id="ws-api-url"
                      aria-label="URL"
                      data-testid="ws-api-url"
                      defaultValue={api.url}
                      placeholder="wss://api.example.com"
                      className="h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 font-mono text-sm text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
                      onBlur={(event) => {
                        if (event.currentTarget.value !== api.url) {
                          patch({ url: event.currentTarget.value });
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          patch({ url: event.currentTarget.value });
                        }
                      }}
                    />
                    <p data-testid="ws-api-url-source" className="truncate text-xs text-fg-subtle">
                      {effective.source === 'api'
                        ? 'A ws:// or wss:// address. Requests connect to this value.'
                        : `Overridden: requests connect to ${effective.url} — from ${SOURCE_LABEL[effective.source]}.`}
                    </p>
                  </div>
                </div>
              </SettingsGroup>
            ),
          },
          {
            id: 'headers',
            label: 'Headers',
            content: (
              <SettingsGroup hint="Sent with every request in this API, before the request’s own.">
                <KvTable
                  label="API headers"
                  testidPrefix="ws-api-headers"
                  rows={api.headers}
                  columns={['enabled', 'name', 'value', 'description']}
                  placeholders={{ name: 'key', value: 'value' }}
                  emptyMessage="No headers."
                  onChange={(rows) => {
                    patch({ headers: [...rows] });
                  }}
                />
              </SettingsGroup>
            ),
          },
          {
            id: 'auth',
            label: 'Authentication',
            content: (
              <SettingsGroup hint="What every request in this API sends unless a folder or the request itself says otherwise.">
                <AuthFields
                  scope="API"
                  labels="settings"
                  auth={api.auth === undefined || api.auth.type === 'inherit' ? undefined : api.auth}
                  onChange={(auth: AuthConfigWire | null) => {
                    patch({ auth });
                  }}
                  oauth2Status={
                    api.auth?.type === 'oauth2' ? (
                      <OAuth2StatusPanel ownerId={apiId} grant={api.auth.grant} />
                    ) : undefined
                  }
                />
              </SettingsGroup>
            ),
          },
          ...(api.definition === undefined
            ? []
            : [
                {
                  id: 'definition' as const,
                  label: 'Definition',
                  content: (
                    <SettingsGroup hint="The AsyncAPI document this API was imported from.">
                      <AsyncApiDefinitionCard apiId={apiId} definition={api.definition} />
                    </SettingsGroup>
                  ),
                },
              ]),
        ]}
      />
    </section>
  );
}
