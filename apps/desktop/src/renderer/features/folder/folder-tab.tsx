/**
 * A folder's page, like a project's or an API's: General (its name, its description rendered and
 * edited in place, and what it holds), Authentication (what every request inside sends unless it
 * says otherwise) and, for a REST or gRPC folder, Scripts (what runs around every request inside).
 * One page for every kind's folders: they share one store and one patch. A WebSocket folder has no
 * scripts, so it has no Scripts tab, as its explorer menu has no Scripts… entry.
 */
import { lazy, Suspense } from 'react';
import { ArrowLeftRight, Folder } from 'lucide-react';
import { AuthFields } from '../../components/auth-fields.js';
import { OverviewPage } from '../../components/overview-page.js';
import { SettingsGroup, TextSetting } from '../../components/settings-grid.js';
import { SettingsPageTabs, type SettingsPageTab } from '../../components/settings-page-tabs.js';
import { useProjectStore } from '../../state/project.js';
import { OAuth2StatusPanel } from '../rest-editor/oauth2-status.js';
import { PagePath } from '../explorer/page-path.js';
import type { AuthConfigWire } from '@shared/wire-base.js';

// The scripts editor is Monaco: loaded with the tab, not with the page.
const ScriptsTab = lazy(async () => {
  const module = await import('../scripts/scripts-tab.js');
  return { default: module.ScriptsTab };
});

export interface FolderTabProps {
  readonly folderId: string;
}

type OwnerKind = 'rest' | 'grpc' | 'ws';

/** The folders inside `folderId`, at any depth. */
export function descendantFolders(
  folderId: string,
  folders: Readonly<Record<string, { readonly parentId?: string | undefined }>>,
): Set<string> {
  const inside = new Set<string>();
  let added = true;
  while (added) {
    added = false;
    for (const [id, folder] of Object.entries(folders)) {
      if (
        !inside.has(id) &&
        folder.parentId !== undefined &&
        (folder.parentId === folderId || inside.has(folder.parentId))
      ) {
        inside.add(id);
        added = true;
      }
    }
  }
  return inside;
}

function countIn(
  folderIds: ReadonlySet<string>,
  requests: Readonly<Record<string, { readonly folderId?: string | undefined }>>,
): number {
  return Object.values(requests).filter((request) => request.folderId !== undefined && folderIds.has(request.folderId))
    .length;
}

function plural(count: number, one: string): string {
  return `${String(count)} ${one}${count === 1 ? '' : 's'}`;
}

export function FolderTab({ folderId }: FolderTabProps) {
  const folder = useProjectStore((state) => state.folders[folderId]);
  const owner = useProjectStore((state): OwnerKind | undefined => {
    const apiId = state.folders[folderId]?.apiId ?? '';
    if (state.grpcApis[apiId] !== undefined) return 'grpc';
    if (state.wsApis[apiId] !== undefined) return 'ws';
    return state.folders[folderId] === undefined ? undefined : 'rest';
  });
  const folderCount = useProjectStore((state) => descendantFolders(folderId, state.folders).size);
  const requestCount = useProjectStore((state) => {
    const inside = new Set([folderId, ...descendantFolders(folderId, state.folders)]);
    const requests = owner === 'grpc' ? state.grpcRequests : owner === 'ws' ? state.wsRequests : state.restRequests;
    return countIn(inside, requests);
  });
  const updateFolder = useProjectStore((state) => state.updateFolder);

  if (folder === undefined || owner === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This folder is no longer in the project.</p>;
  }

  const tabs: SettingsPageTab<'general' | 'auth' | 'scripts'>[] = [
    {
      id: 'general',
      label: 'General',
      content: (
        <OverviewPage
          testIdPrefix="folder-overview"
          name={folder.name}
          description={folder.description}
          subject="this folder"
          onSaveDescription={(description) => {
            void updateFolder(folderId, { description });
          }}
          fields={
            <SettingsGroup>
              <TextSetting
                label="Name"
                testId="folder-name"
                value={folder.name}
                onCommit={(name) => {
                  if (name.trim().length > 0 && name.trim() !== folder.name) {
                    void updateFolder(folderId, { name: name.trim() });
                  }
                }}
              />
            </SettingsGroup>
          }
          aside={
            <ul aria-label="Summary" data-testid="folder-summary" className="flex flex-col gap-2.5 text-sm">
              <li className="flex items-center gap-2">
                <ArrowLeftRight size={14} className="text-fg-subtle" aria-hidden="true" />
                <span data-testid="folder-summary-requests">{plural(requestCount, 'request')}</span>
              </li>
              <li className="flex items-center gap-2">
                <Folder size={14} className="text-fg-subtle" aria-hidden="true" />
                <span data-testid="folder-summary-folders">{plural(folderCount, 'folder')}</span>
              </li>
            </ul>
          }
        />
      ),
    },
    {
      id: 'auth',
      label: 'Authentication',
      content: (
        <SettingsGroup hint="Used by every request in this folder that configures none of its own.">
          <AuthFields
            scope="Folder"
            labels="settings"
            inheritable
            auth={folder.auth === undefined || folder.auth.type === 'inherit' ? undefined : folder.auth}
            onChange={(auth: AuthConfigWire | null) => {
              void updateFolder(folderId, { auth: auth ?? { type: 'inherit' } });
            }}
            oauth2Status={
              folder.auth?.type === 'oauth2' ? (
                <OAuth2StatusPanel ownerId={folderId} grant={folder.auth.grant} />
              ) : undefined
            }
          />
        </SettingsGroup>
      ),
    },
  ];
  if (owner !== 'ws') {
    tabs.push({
      id: 'scripts',
      label: 'Scripts',
      fill: true,
      content: (
        <div data-testid="folder-scripts" className="flex min-h-0 flex-1 flex-col rounded-md border border-hairline">
          <Suspense fallback={null}>
            <ScriptsTab requestId={folderId} scripts={folder.scripts} level="folder" />
          </Suspense>
        </div>
      ),
    });
  }

  return (
    <section aria-label={`Folder ${folder.name}`} data-testid="folder-tab" className="h-full min-h-0">
      <SettingsPageTabs
        pageId={folderId}
        label="Folder settings"
        tabs={tabs}
        header={<PagePath folderId={folderId} />}
      />
    </section>
  );
}
