/**
 * The API tab: what an API is, where it points, and what it sends.
 *
 * The base URL is the field that needs care. An environment can override it, and when one does the
 * override — not the field — is what requests go to, so the row shows both: the API's own value,
 * editable, and beside it the value that actually wins and where it came from. Anything else would
 * let a user edit a field and watch their requests ignore it.
 *
 * The servers an import recorded are offered as a datalist rather than a select: the list is a
 * suggestion from the definition, and a user may point an API anywhere.
 */
import { AuthFields } from '../../components/auth-fields.js';
import { Button } from '../../components/button.js';
import { ReadOnlySetting, SettingsGroup, TextSetting } from '../../components/settings-grid.js';
import { useProjectStore } from '../../state/project.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { AuthConfigWire, EndpointAuthWire, RestApiWire } from '../../../shared/wire-types.js';

/** Where the base URL a request actually uses comes from. Mirrors the engine's `BaseUrlSource`. */
export type BaseUrlSource = 'api' | 'environment' | 'workspace-environment';

/** How each source reads beside the field. */
const SOURCE_LABEL: Readonly<Record<BaseUrlSource, string>> = {
  api: 'the API',
  environment: 'this project’s environment',
  'workspace-environment': 'the workspace environment',
};

/**
 * The base URL in force for one API, and where it came from.
 *
 * Mirrors the engine's precedence: the project's own active environment wins over the workspace
 * environment, and either wins over the API's own field. Keyed by the API's **slug**, which is what
 * an environment's `endpoints` map uses.
 */
export function effectiveBaseUrl(input: {
  readonly api: Pick<RestApiWire, 'slug' | 'baseUrl'>;
  readonly projectOverride?: string | undefined;
  readonly workspaceOverride?: string | undefined;
}): { readonly url: string; readonly source: BaseUrlSource } {
  if (input.projectOverride !== undefined && input.projectOverride !== '') {
    return { url: input.projectOverride, source: 'environment' };
  }
  if (input.workspaceOverride !== undefined && input.workspaceOverride !== '') {
    return { url: input.workspaceOverride, source: 'workspace-environment' };
  }
  return { url: input.api.baseUrl, source: 'api' };
}

export interface ApiTabProps {
  readonly apiId: string;
}

/** One API's page. */
export function ApiTab({ apiId }: ApiTabProps) {
  const api = useProjectStore((state) => state.apis[apiId]);
  const projectId = useProjectStore((state) => state.projectOf[apiId]);
  const project = useProjectStore((state) => (projectId === undefined ? undefined : state.projects[projectId]));
  const updateApi = useProjectStore((state) => state.updateApi);
  const workspaceEnvironments = useWorkspaceStore((state) => state.workspace?.environments);
  const activeWorkspaceEnvironmentId = useWorkspaceStore((state) => state.workspace?.activeEnvironmentId);

  if (api === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This API is no longer in the project.</p>;
  }

  const projectEnvironment = project?.environments.find((candidate) => candidate.id === project.activeEnvironmentId);
  const workspaceEnvironment = workspaceEnvironments?.find(
    (candidate) => candidate.id === activeWorkspaceEnvironmentId,
  );
  const effective = effectiveBaseUrl({
    api,
    projectOverride: projectEnvironment?.endpoints[api.slug],
    workspaceOverride: workspaceEnvironment?.endpoints[api.slug],
  });

  const patch = (changes: Parameters<typeof updateApi>[1]): void => {
    void updateApi(apiId, changes);
  };

  return (
    <section aria-label={`API ${api.name}`} data-testid="api-tab" className="h-full overflow-auto p-3">
      <SettingsGroup title="API">
        <TextSetting
          label="Name"
          testId="api-name"
          value={api.name}
          onCommit={(name) => {
            if (name.trim().length > 0) {
              patch({ name: name.trim() });
            }
          }}
        />
        <TextSetting
          label="Description"
          testId="api-description"
          value={api.description ?? ''}
          onCommit={(description) => {
            patch({ description: description === '' ? null : description });
          }}
        />
        <div className="flex items-center gap-2 py-0.5">
          <label htmlFor="api-base-url" className="w-44 shrink-0 truncate text-sm text-fg-muted">
            Base URL
          </label>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <input
              id="api-base-url"
              aria-label="Base URL"
              data-testid="api-base-url"
              list={api.servers.length > 0 ? 'api-servers' : undefined}
              defaultValue={api.baseUrl}
              placeholder="https://api.example.com"
              className="h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 font-mono text-sm text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
              onBlur={(event) => {
                if (event.currentTarget.value !== api.baseUrl) {
                  patch({ baseUrl: event.currentTarget.value });
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  patch({ baseUrl: event.currentTarget.value });
                }
              }}
            />
            {api.servers.length > 0 && (
              <datalist id="api-servers">
                {api.servers.map((server) => (
                  <option key={server.url} value={server.url}>
                    {server.description ?? server.url}
                  </option>
                ))}
              </datalist>
            )}
            <p data-testid="api-base-url-source" className="truncate text-xs text-fg-subtle">
              {effective.source === 'api'
                ? 'Requests use this value.'
                : `Overridden: requests go to ${effective.url} — from ${SOURCE_LABEL[effective.source]}.`}
            </p>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Authentication"
        hint="What every request in this API sends unless a folder or the request itself says otherwise."
      >
        <AuthFields
          scope="API"
          auth={api.auth === undefined || api.auth.type === 'inherit' ? undefined : (api.auth as EndpointAuthWire)}
          onChange={(auth: AuthConfigWire | null) => {
            patch({ auth });
          }}
        />
      </SettingsGroup>

      {api.definition !== undefined && (
        <SettingsGroup title="Definition">
          <div data-testid="api-definition-card" className="flex flex-col gap-1">
            <ReadOnlySetting label="Source" value={api.definition.source} testId="api-definition-source" />
            <ReadOnlySetting label="Version" value={api.definition.version} />
            <ReadOnlySetting label="Cached" value={api.definition.cache ? 'yes' : 'no'} />
            <div className="flex gap-2 pt-1">
              {/* Both land with the OpenAPI import task, which is what produces a definition at
                  all; they are here, disabled, so the card's shape does not change under the user
                  once it can do something. */}
              <Button variant="secondary" disabled title="Viewing an imported definition arrives with the import task.">
                View document
              </Button>
              <Button
                variant="secondary"
                disabled
                title="Exporting an imported definition arrives with the import task."
              >
                Export…
              </Button>
            </div>
          </div>
        </SettingsGroup>
      )}
    </section>
  );
}
