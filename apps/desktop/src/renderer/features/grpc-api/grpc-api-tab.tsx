/**
 * The gRPC API tab: what an API is, where it points, and what every call in it sends.
 *
 * The target is the field that needs care, for the same reason a REST API's base URL does: an
 * environment can override it (under the API's slug, the same slot a REST base URL uses), and when
 * one does the override is where calls go. The row shows both. TLS is the API's own decision, since
 * a `host:port` target says nothing about it — unlike a URL's scheme.
 */
import { AuthFields } from '../../components/auth-fields.js';
import { Button } from '../../components/button.js';
import { KvTable } from '../../components/kv-table.js';
import { BooleanSetting, SettingsGroup, TextSetting } from '../../components/settings-grid.js';
import { OAuth2StatusPanel } from '../rest-editor/oauth2-status.js';
import { GrpcDefinitionCard } from './grpc-definition-card.js';
import { effectiveBaseUrl } from '../rest-api/api-tab.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { AuthConfigWire } from '../../../shared/wire-types.js';

export interface GrpcApiTabProps {
  readonly apiId: string;
}

/** How each override source reads beside the field. */
const SOURCE_LABEL = {
  environment: 'this project’s environment',
  'workspace-environment': 'the workspace environment',
} as const;

/** One gRPC API's page. */
export function GrpcApiTab({ apiId }: GrpcApiTabProps) {
  const api = useProjectStore((state) => state.grpcApis[apiId]);
  const projectId = useProjectStore((state) => state.projectOf[apiId]);
  const project = useProjectStore((state) => (projectId === undefined ? undefined : state.projects[projectId]));
  const updateGrpcApi = useProjectStore((state) => state.updateGrpcApi);
  const workspaceEnvironments = useWorkspaceStore((state) => state.workspace?.environments);
  const activeWorkspaceEnvironmentId = useWorkspaceStore((state) => state.workspace?.activeEnvironmentId);
  const openImportDialog = useUiStore((state) => state.openImportDialog);

  if (api === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This API is no longer in the project.</p>;
  }

  const projectEnvironment = project?.environments.find((candidate) => candidate.id === project.activeEnvironmentId);
  const workspaceEnvironment = workspaceEnvironments?.find(
    (candidate) => candidate.id === activeWorkspaceEnvironmentId,
  );
  const effective = effectiveBaseUrl({
    api: { slug: api.slug, baseUrl: api.target },
    projectOverride: projectEnvironment?.endpoints[api.slug],
    workspaceOverride: workspaceEnvironment?.endpoints[api.slug],
  });

  const patch = (changes: Parameters<typeof updateGrpcApi>[1]): void => {
    void updateGrpcApi(apiId, changes);
  };

  return (
    <section aria-label={`gRPC API ${api.name}`} data-testid="grpc-api-tab" className="h-full overflow-auto p-3">
      <SettingsGroup title="gRPC API">
        <TextSetting
          label="Name"
          testId="grpc-api-name"
          value={api.name}
          onCommit={(name) => {
            if (name.trim().length > 0) {
              patch({ name: name.trim() });
            }
          }}
        />
        <TextSetting
          label="Description"
          testId="grpc-api-description"
          value={api.description ?? ''}
          onCommit={(description) => {
            patch({ description: description === '' ? null : description });
          }}
        />
        <TextSetting
          label="Target"
          testId="grpc-api-target"
          value={api.target}
          monospace
          placeholder="host:port"
          hint={
            effective.source === 'api'
              ? 'host:port, or a grpc:// / grpcs:// address. Calls use this value.'
              : `Overridden: calls go to ${effective.url} — from ${SOURCE_LABEL[effective.source]}.`
          }
          onCommit={(target) => {
            if (target.trim() !== api.target) {
              patch({ target: target.trim() });
            }
          }}
        />
        <BooleanSetting
          label="TLS"
          testId="grpc-api-tls"
          value={api.tls}
          hint="Connect with TLS (grpcs). Off speaks plain HTTP/2 to the target."
          onChange={(tls) => {
            patch({ tls });
          }}
        />
      </SettingsGroup>

      <SettingsGroup title="Metadata" hint="Sent with every call in this API, before the request’s own.">
        <KvTable
          label="API metadata"
          testidPrefix="grpc-api-metadata"
          rows={api.metadata}
          columns={['enabled', 'name', 'value', 'description']}
          placeholders={{ name: 'key', value: 'value' }}
          emptyMessage="No metadata."
          onChange={(rows) => {
            patch({ metadata: [...rows] });
          }}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Authentication"
        hint="What every call in this API sends unless a folder or the request itself says otherwise."
      >
        <AuthFields
          scope="API"
          auth={api.auth === undefined || api.auth.type === 'inherit' ? undefined : api.auth}
          onChange={(auth: AuthConfigWire | null) => {
            patch({ auth });
          }}
          oauth2Status={
            api.auth?.type === 'oauth2' ? <OAuth2StatusPanel ownerId={apiId} grant={api.auth.grant} /> : undefined
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Definition">
        {api.definition !== undefined ? (
          <GrpcDefinitionCard apiId={apiId} definition={api.definition} />
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-fg-subtle">
              No definition. Requests can still name a service and method by hand, but a message cannot be encoded
              without one — import <span className="font-mono">.proto</span> files, or discover them from a running
              server.
            </p>
            <div>
              <Button
                variant="secondary"
                data-testid="grpc-api-import-proto"
                onClick={() => {
                  openImportDialog('proto');
                }}
              >
                Import definition…
              </Button>
            </div>
          </div>
        )}
      </SettingsGroup>
    </section>
  );
}
