/**
 * The parts of a request's path line above its editor (project, API, folders), each one a way back: a click
 * opens that part's tab (the project's, the API's, the folder's) and reveals its row in the Explorer.
 */
import { useMemo } from 'react';
import type { TrailSegment } from '../../components/breadcrumb.js';
import { useProjectStore, type ProjectStore } from '../../state/project.js';
import { revealNode } from './explorer-api.js';
import { pathParts } from './page-path.js';

type TrailState = Pick<
  ProjectStore,
  'projects' | 'projectOf' | 'apis' | 'grpcApis' | 'wsApis' | 'mcpServers' | 'folders'
>;

/** Opens a part's tab, then shows its row in the Explorer: unfolded to, selected and scrolled into view. */
export function openAndReveal(open: () => void, rowId: string): () => void {
  return () => {
    open();
    revealNode(rowId);
  };
}

/** Where a request sits: its project (else its API's), its API, and the folder it is in. */
export interface RequestLocation {
  readonly projectId?: string;
  readonly apiId: string;
  readonly folderId?: string;
}

/** The trail of a request at `location`, outermost first, every part opening its tab. */
export function requestTrail(location: RequestLocation, state: TrailState): TrailSegment[] {
  return pathParts(location, state, { openLast: true })
    .filter((part) => part.label.length > 0)
    .map((part) => {
      const { open, rowId } = part;
      return open === undefined || rowId === undefined
        ? { text: part.label }
        : { text: part.label, open: openAndReveal(open, rowId) };
    });
}

/** {@link requestTrail}, kept current as anything along the path is renamed. */
export function useRequestTrail(location: RequestLocation | undefined): readonly TrailSegment[] {
  const projects = useProjectStore((state) => state.projects);
  const projectOf = useProjectStore((state) => state.projectOf);
  const apis = useProjectStore((state) => state.apis);
  const grpcApis = useProjectStore((state) => state.grpcApis);
  const wsApis = useProjectStore((state) => state.wsApis);
  const mcpServers = useProjectStore((state) => state.mcpServers);
  const folders = useProjectStore((state) => state.folders);
  const projectId = location?.projectId;
  const apiId = location?.apiId;
  const folderId = location?.folderId;
  return useMemo(
    () =>
      apiId === undefined
        ? []
        : requestTrail(
            {
              apiId,
              ...(projectId !== undefined ? { projectId } : {}),
              ...(folderId !== undefined ? { folderId } : {}),
            },
            { projects, projectOf, apis, grpcApis, wsApis, mcpServers, folders },
          ),
    [apiId, projectId, folderId, projects, projectOf, apis, grpcApis, wsApis, mcpServers, folders],
  );
}

/** The location of a request record (any kind with an API and maybe a folder) in project `projectId`. */
export function requestLocation(
  request: { readonly apiId: string; readonly folderId?: string | undefined } | undefined,
  projectId: string | undefined,
): RequestLocation | undefined {
  if (request === undefined) return undefined;
  return {
    apiId: request.apiId,
    ...(projectId !== undefined ? { projectId } : {}),
    ...(request.folderId !== undefined ? { folderId: request.folderId } : {}),
  };
}
