/**
 * The REST API page's Overview: what the API is for, in its own words. The description is Markdown,
 * often written by whoever published the definition, so it is shown rendered; Edit swaps it for the
 * source text in place. A draft being edited is the user's: an Update definition that rewrites the
 * description underneath does not replace it, Save or Cancel decides.
 */
import { useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Pencil } from 'lucide-react';
import { Button } from '../../components/button.js';
import { MarkdownView } from '../../components/markdown-view.js';
import { useProjectStore } from '../../state/project.js';

export interface OverviewTabProps {
  readonly apiId: string;
  /** Opens the full documentation; the link is shown only when this is given. */
  readonly onOpenDocs?: () => void;
  /** The summary column beside the description. */
  readonly aside?: ReactNode;
}

export function OverviewTab({ apiId, onOpenDocs, aside }: OverviewTabProps) {
  const api = useProjectStore((state) => state.apis[apiId]);
  const updateApi = useProjectStore((state) => state.updateApi);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  if (api === undefined) {
    return null;
  }
  const description = api.description ?? '';

  const startEditing = (): void => {
    setDraft(description);
    // The textarea mounts on this render; focus it once it is there.
    requestAnimationFrame(() => editorRef.current?.focus());
  };
  const cancel = (): void => {
    setDraft(undefined);
  };
  const save = (): void => {
    if (draft === undefined) return;
    const next = draft.trim() === '' ? null : draft;
    if (next !== (api.description ?? null)) {
      void updateApi(apiId, { description: next });
    }
    setDraft(undefined);
  };

  return (
    <div data-testid="api-overview" className="@container">
      <div className="flex flex-col gap-6 @[56rem]:flex-row @[56rem]:items-start">
        <article className="min-w-0 flex-1">
          <div className="mb-3 flex items-start justify-between gap-3">
            <h2 className="min-w-0 text-xl font-semibold break-words text-fg-default">{api.name}</h2>
            {draft === undefined && description !== '' && (
              <Button variant="ghost" data-testid="api-overview-edit" onClick={startEditing}>
                <Pencil size={13} aria-hidden="true" />
                Edit
              </Button>
            )}
          </div>

          {draft !== undefined ? (
            <div className="flex flex-col gap-2">
              <textarea
                ref={editorRef}
                aria-label="Description"
                data-testid="api-overview-editor"
                value={draft}
                rows={14}
                placeholder="What this API is for, in Markdown."
                className="w-full resize-y rounded-md border border-hairline-strong bg-surface-raised p-2 font-mono text-sm text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
                onChange={(event) => {
                  setDraft(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    cancel();
                  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    save();
                  }
                }}
              />
              <div className="flex items-center gap-2">
                <Button variant="primary" data-testid="api-overview-save" onClick={save}>
                  Save
                </Button>
                <Button data-testid="api-overview-cancel" onClick={cancel}>
                  Cancel
                </Button>
                <span className="text-xs text-fg-subtle">Markdown. ⌘/Ctrl+Enter saves, Escape cancels.</span>
              </div>
            </div>
          ) : description !== '' ? (
            <MarkdownView source={description} />
          ) : (
            <div data-testid="api-overview-empty" className="flex flex-col items-start gap-2">
              <p className="text-sm text-fg-subtle">No description.</p>
              <Button data-testid="api-overview-add" onClick={startEditing}>
                Add description
              </Button>
            </div>
          )}

          {onOpenDocs !== undefined && (
            <div className="mt-6 border-t border-hairline pt-3">
              <button
                type="button"
                data-testid="api-overview-docs"
                onClick={onOpenDocs}
                className="inline-flex items-center gap-1.5 text-sm text-accent hover:text-accent-hover hover:underline"
              >
                View complete documentation
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            </div>
          )}
        </article>
        {aside !== undefined && <aside className="w-full shrink-0 @[56rem]:w-72">{aside}</aside>}
      </div>
    </div>
  );
}
