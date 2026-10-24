/**
 * The REST API page's General tab: what the API is for, in its own words, beside its summary. The
 * layout and the description's in-place editing are {@link OverviewPage}'s, shared with a folder's page.
 */
import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { OverviewPage } from '../../components/overview-page.js';
import { useProjectStore } from '../../state/project.js';

export interface OverviewTabProps {
  readonly apiId: string;
  /** Opens the full documentation; the link is shown only when this is given. */
  readonly onOpenDocs?: () => void;
  /** The summary column beside the description. */
  readonly aside?: ReactNode;
  /** The page's own settings (the API's name and base URL), between the heading and the description. */
  readonly fields?: ReactNode;
}

export function OverviewTab({ apiId, onOpenDocs, aside, fields }: OverviewTabProps) {
  const api = useProjectStore((state) => state.apis[apiId]);
  const updateApi = useProjectStore((state) => state.updateApi);
  if (api === undefined) {
    return null;
  }
  return (
    <OverviewPage
      testIdPrefix="api-overview"
      name={api.name}
      description={api.description}
      subject="this API"
      onSaveDescription={(description) => {
        void updateApi(apiId, { description });
      }}
      fields={fields}
      aside={aside}
      footer={
        onOpenDocs === undefined ? undefined : (
          <button
            type="button"
            data-testid="api-overview-docs"
            onClick={onOpenDocs}
            className="inline-flex items-center gap-1.5 text-sm text-accent hover:text-accent-hover hover:underline"
          >
            View complete documentation
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        )
      }
    />
  );
}
