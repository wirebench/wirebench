/**
 * The Overview's side column: how big the API is, how it authenticates, where its requests go and
 * where its definition came from, each line a fact. Auth and Definition jump to their tabs, which
 * hold the controls; nothing here edits anything.
 */
import type { ReactNode } from 'react';
import { ArrowLeftRight, FileCode2, Folder, Globe, KeyRound } from 'lucide-react';
import { authTypeLabel } from '../../components/auth-fields.js';
import { useSettingsPageTabStore } from '../../components/settings-page-tabs.js';
import { useProjectStore } from '../../state/project.js';

export interface ApiSummaryProps {
  readonly apiId: string;
  /** The base URL requests go to, and where it comes from ("the API", an environment). */
  readonly baseUrl: { readonly url: string; readonly from: string };
  /** Shown under the facts: the Recent changes list. */
  readonly children?: ReactNode;
}

/** How many requests and folders (at any depth) the API holds. */
export function countApi(
  apiId: string,
  folders: Readonly<Record<string, { readonly apiId: string }>>,
  requests: Readonly<Record<string, { readonly apiId: string }>>,
): { readonly requests: number; readonly folders: number } {
  return {
    requests: Object.values(requests).filter((request) => request.apiId === apiId).length,
    folders: Object.values(folders).filter((folder) => folder.apiId === apiId).length,
  };
}

function plural(count: number, one: string): string {
  return `${String(count)} ${one}${count === 1 ? '' : 's'}`;
}

/** The file or host name of a definition's source, which is what a person recognises it by. */
export function sourceName(source: string): string {
  try {
    const url = new URL(source);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const last = url.pathname
        .split('/')
        .filter((part) => part !== '')
        .at(-1);
      return last ?? url.host;
    }
  } catch {
    // Not a URL: a path on disk.
  }
  return (
    source
      .split(/[\\/]/)
      .filter((part) => part !== '')
      .at(-1) ?? source
  );
}

function Fact({ icon, children }: { readonly icon: ReactNode; readonly children: ReactNode }) {
  return (
    <li className="flex min-w-0 items-start gap-2 text-sm text-fg-default">
      <span className="mt-0.5 shrink-0 text-fg-subtle" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  );
}

const LINK_CLASS = 'text-left text-accent hover:text-accent-hover hover:underline';

export function ApiSummary({ apiId, baseUrl, children }: ApiSummaryProps) {
  const api = useProjectStore((state) => state.apis[apiId]);
  // Two number selectors: one returning a fresh object would re-render without end.
  const requestCount = useProjectStore((state) => countApi(apiId, state.folders, state.restRequests).requests);
  const folderCount = useProjectStore((state) => countApi(apiId, state.folders, state.restRequests).folders);
  const counts = { requests: requestCount, folders: folderCount };
  const select = useSettingsPageTabStore((state) => state.select);
  if (api === undefined) {
    return null;
  }
  const auth = api.auth === undefined || api.auth.type === 'inherit' ? 'none' : api.auth.type;

  return (
    <div data-testid="api-summary" className="flex flex-col gap-4">
      <ul aria-label="Summary" className="flex flex-col gap-2.5">
        <Fact icon={<ArrowLeftRight size={14} />}>
          <span data-testid="api-summary-requests">{plural(counts.requests, 'request')}</span>
        </Fact>
        <Fact icon={<Folder size={14} />}>
          <span data-testid="api-summary-folders">{plural(counts.folders, 'folder')}</span>
        </Fact>
        <Fact icon={<KeyRound size={14} />}>
          <button
            type="button"
            data-testid="api-summary-auth"
            className={LINK_CLASS}
            onClick={() => {
              select(apiId, 'auth');
            }}
          >
            {authTypeLabel(auth)}
          </button>
        </Fact>
        <Fact icon={<Globe size={14} />}>
          <span data-testid="api-summary-base-url" className="block truncate font-mono text-xs" title={baseUrl.url}>
            {baseUrl.url === '' ? 'No base URL' : baseUrl.url}
          </span>
          <span className="block text-xs text-fg-subtle">From {baseUrl.from}</span>
        </Fact>
        {api.definition !== undefined && (
          <Fact icon={<FileCode2 size={14} />}>
            <button
              type="button"
              data-testid="api-summary-definition"
              title={api.definition.source}
              className={`${LINK_CLASS} block max-w-full truncate`}
              onClick={() => {
                select(apiId, 'definition');
              }}
            >
              {sourceName(api.definition.source)}
            </button>
          </Fact>
        )}
      </ul>
      {children}
    </div>
  );
}
