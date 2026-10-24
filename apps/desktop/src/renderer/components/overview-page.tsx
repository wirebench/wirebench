/**
 * The General tab of a page that has a description: an API's or a folder's. The name as a heading,
 * the page's own fields under it, then the description, which is Markdown (often written by whoever
 * published the definition) and so shown rendered; Edit swaps it for the source text in place. A
 * draft being edited is the user's: a description rewritten underneath (an Update definition) does
 * not replace it, Save or Cancel decides. A summary column sits beside it on a wide page.
 */
import { useRef, useState, type ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import { Button } from './button.js';
import { MarkdownView } from './markdown-view.js';

export interface OverviewPageProps {
  /** Prefixes every test id: `api-overview`, `folder-overview`. */
  readonly testIdPrefix: string;
  readonly name: string;
  readonly description: string | undefined;
  /** Saves the edited text; `null` when it was emptied. Called only when it changed. */
  readonly onSaveDescription: (description: string | null) => void;
  /** What the description is about, for the editor's placeholder ("this API", "this folder"). */
  readonly subject: string;
  /** The page's own settings, between the heading and the description. */
  readonly fields?: ReactNode;
  /** The summary column beside the description. */
  readonly aside?: ReactNode;
  /** Under the description, e.g. a link to the full documentation. */
  readonly footer?: ReactNode;
}

export function OverviewPage({
  testIdPrefix,
  name,
  description: stored,
  onSaveDescription,
  subject,
  fields,
  aside,
  footer,
}: OverviewPageProps) {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const description = stored ?? '';

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
    if (next !== (stored ?? null)) {
      onSaveDescription(next);
    }
    setDraft(undefined);
  };

  return (
    <div data-testid={testIdPrefix} className="@container">
      <div className="flex flex-col gap-6 @[56rem]:flex-row @[56rem]:items-start">
        <article className="min-w-0 flex-1">
          <h2 className="mb-3 min-w-0 text-xl font-semibold break-words text-fg-default">{name}</h2>
          {fields !== undefined && <div className="mb-4">{fields}</div>}

          <div className="mb-1 flex items-center justify-between gap-3">
            <h3 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">Description</h3>
            {draft === undefined && description !== '' && (
              <Button variant="ghost" data-testid={`${testIdPrefix}-edit`} onClick={startEditing}>
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
                data-testid={`${testIdPrefix}-editor`}
                value={draft}
                rows={14}
                placeholder={`What ${subject} is for, in Markdown.`}
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
                <Button variant="primary" data-testid={`${testIdPrefix}-save`} onClick={save}>
                  Save
                </Button>
                <Button data-testid={`${testIdPrefix}-cancel`} onClick={cancel}>
                  Cancel
                </Button>
                <span className="text-xs text-fg-subtle">Markdown. ⌘/Ctrl+Enter saves, Escape cancels.</span>
              </div>
            </div>
          ) : description !== '' ? (
            <MarkdownView source={description} />
          ) : (
            <div data-testid={`${testIdPrefix}-empty`} className="flex flex-col items-start gap-2">
              <p className="text-sm text-fg-subtle">No description.</p>
              <Button data-testid={`${testIdPrefix}-add`} onClick={startEditing}>
                Add description
              </Button>
            </div>
          )}

          {footer !== undefined && <div className="mt-6 border-t border-hairline pt-3">{footer}</div>}
        </article>
        {aside !== undefined && <aside className="w-full shrink-0 @[56rem]:w-72">{aside}</aside>}
      </div>
    </div>
  );
}
