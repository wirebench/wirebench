/**
 * Renders a description written in Markdown: an API's, a folder's or a request's, most often one an
 * import brought in, so the text is untrusted. Raw HTML is skipped, images are never fetched (their
 * alt text stands in), and only http(s) links survive; they open in the system browser through the
 * window-open handler, which allows nothing else either.
 */
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface MarkdownViewProps {
  readonly source: string;
  readonly className?: string;
}

/** Only web links leave the app; every other scheme (`javascript:`, `file:`, `data:`, relative) is dropped. */
export function safeHref(url: string): string {
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : '';
}

const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="mt-4 mb-2 text-xl font-semibold text-fg-default first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 mb-2 text-lg font-semibold text-fg-default first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-md font-semibold text-fg-default first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-3 mb-1 text-sm font-semibold text-fg-default first:mt-0">{children}</h4>,
  h5: ({ children }) => <h5 className="mt-3 mb-1 text-sm font-semibold text-fg-muted first:mt-0">{children}</h5>,
  h6: ({ children }) => <h6 className="mt-3 mb-1 text-sm font-semibold text-fg-muted first:mt-0">{children}</h6>,
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal pl-6">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-hairline-strong pl-3 text-fg-muted">{children}</blockquote>
  ),
  hr: () => <hr className="my-4 border-hairline" />,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md border border-hairline bg-surface-sunken p-3 font-mono text-xs">
      {children}
    </pre>
  ),
  code: ({ children, className }) => (
    // Inside a `pre` the block styles apply; inline code gets its own chip.
    <code className={className ?? 'rounded bg-surface-sunken px-1 py-0.5 font-mono text-[0.9em]'}>{children}</code>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-hairline bg-surface-raised px-2 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-hairline px-2 py-1 align-top">{children}</td>,
  a: ({ href, children }) =>
    href === undefined || href === '' ? (
      <span>{children}</span>
    ) : (
      <a href={href} target="_blank" rel="noreferrer" className="text-accent underline hover:text-accent-hover">
        {children}
      </a>
    ),
  // Never fetched: an image in an imported description would otherwise make the app call out.
  img: ({ alt }) => (alt === undefined || alt === '' ? null : <span className="text-fg-muted">{alt}</span>),
};

export function MarkdownView({ source, className }: MarkdownViewProps) {
  return (
    <div data-testid="markdown-view" className={`text-sm leading-relaxed text-fg-default ${className ?? ''}`}>
      <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeHref} components={COMPONENTS}>
        {source}
      </Markdown>
    </div>
  );
}
