/**
 * Where a page sits, above its tabs: the project, then the API, then each folder down to this one
 * ("caas › CaaS Card Issuing API › 4. Accounts"). Every part but the last opens that part's page —
 * the project's, the API's (whatever its kind) or the folder's.
 */
import { ChevronRight } from 'lucide-react';
import { Fragment } from 'react';
import { useProjectStore, type ProjectStore } from '../../state/project.js';
import { openApiTab } from '../rest-api/api-actions.js';
import { openGrpcApiTab } from '../grpc-api/grpc-api-actions.js';
import { openWsApiTab } from '../ws-api/ws-api-actions.js';
import { openMcpApiTab } from '../mcp-api/mcp-api-actions.js';
import { openFolderTab } from '../folder/folder-actions.js';
import { openProjectTab } from './project-actions.js';

export interface PagePathProps {
  /** The page is this project's. */
  readonly projectId?: string;
  /** The page is this API's (REST, gRPC, WebSocket or MCP). */
  readonly apiId?: string;
  /** The page is this folder's. */
  readonly folderId?: string;
}

export interface PathPart {
  readonly label: string;
  /** Opens the part's page; absent for the page the path is on. */
  readonly open?: () => void;
}

type PathState = Pick<
  ProjectStore,
  'projects' | 'projectOf' | 'apis' | 'grpcApis' | 'wsApis' | 'mcpServers' | 'folders'
>;

function apiPart(apiId: string, state: PathState): PathPart | undefined {
  const rest = state.apis[apiId];
  if (rest !== undefined) return { label: rest.name, open: () => openApiTab(apiId) };
  const grpc = state.grpcApis[apiId];
  if (grpc !== undefined) return { label: grpc.name, open: () => openGrpcApiTab(apiId) };
  const ws = state.wsApis[apiId];
  if (ws !== undefined) return { label: ws.name, open: () => openWsApiTab(apiId) };
  const mcp = state.mcpServers[apiId];
  if (mcp !== undefined) return { label: mcp.name, open: () => openMcpApiTab(apiId) };
  return undefined;
}

/** The parts of the path to the page `props` names, outermost first; the last one does not open. */
export function pathParts(props: PagePathProps, state: PathState): PathPart[] {
  const parts: PathPart[] = [];
  const folders: PathPart[] = [];
  let apiId = props.apiId;
  if (props.folderId !== undefined) {
    // Up the folder chain; a cycle cannot happen in a saved tree, but the seen set keeps it finite.
    const seen = new Set<string>();
    for (let id: string | undefined = props.folderId; id !== undefined && !seen.has(id);) {
      seen.add(id);
      const folder: (typeof state.folders)[string] | undefined = state.folders[id];
      if (folder === undefined) break;
      const folderId = id;
      folders.unshift({ label: folder.name, open: () => openFolderTab(folderId) });
      apiId = folder.apiId;
      id = folder.parentId;
    }
  }
  const projectId = props.projectId ?? (apiId === undefined ? undefined : state.projectOf[apiId]);
  const project = projectId === undefined ? undefined : state.projects[projectId];
  if (project !== undefined && projectId !== undefined) {
    parts.push({ label: project.name, open: () => openProjectTab(projectId) });
  }
  if (apiId !== undefined) {
    const api = apiPart(apiId, state);
    if (api !== undefined) parts.push(api);
  }
  parts.push(...folders);
  const last = parts.at(-1);
  if (last !== undefined) parts[parts.length - 1] = { label: last.label };
  return parts;
}

export function PagePath(props: PagePathProps) {
  const projects = useProjectStore((state) => state.projects);
  const projectOf = useProjectStore((state) => state.projectOf);
  const apis = useProjectStore((state) => state.apis);
  const grpcApis = useProjectStore((state) => state.grpcApis);
  const wsApis = useProjectStore((state) => state.wsApis);
  const mcpServers = useProjectStore((state) => state.mcpServers);
  const folders = useProjectStore((state) => state.folders);
  const parts = pathParts(props, { projects, projectOf, apis, grpcApis, wsApis, mcpServers, folders });
  if (parts.length === 0) return null;

  return (
    <nav aria-label="Path" data-testid="page-path" className="shrink-0 px-4 pt-2">
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-fg-subtle">
        {parts.map((part, index) => (
          <Fragment key={`${String(index)}-${part.label}`}>
            {index > 0 && (
              <li aria-hidden="true" className="shrink-0">
                <ChevronRight size={12} />
              </li>
            )}
            <li className="min-w-0">
              {part.open === undefined ? (
                <span aria-current="page" className="truncate font-medium text-fg-default">
                  {part.label}
                </span>
              ) : (
                <button type="button" onClick={part.open} className="truncate hover:text-fg-default hover:underline">
                  {part.label}
                </button>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
