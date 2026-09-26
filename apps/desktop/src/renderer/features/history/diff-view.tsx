import { useState } from 'react';
import { Tabs, type TabItem } from '../../components/tabs.js';
import { DiffXmlEditor } from '../../editor/diff-xml-editor.js';
import type { EditorTab } from '../../state/editors.js';
import { prettyPrintBody } from './history-format.js';

export interface DiffViewProps {
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly leftXml: string;
  readonly rightXml: string;
  /** Set when both sides are REST: the normalised texts of the Response and Request tabs. */
  readonly rest?: NonNullable<EditorTab['diff']>['rest'];
}

type RestPane = 'response' | 'request';

const REST_PANES: readonly TabItem<RestPane>[] = [
  { id: 'response', label: 'Response' },
  { id: 'request', label: 'Request' },
];

/**
 * A read-only diff tab (`editors.ts` `kind: 'diff'`): two recorded bodies, pretty-printed, side by
 * side in Monaco's `DiffEditor`, with a header naming both sides and toggles for layout and
 * whitespace.
 *
 * Both sides are formatted as whatever they turn out to be — two JSON bodies are reformatted as
 * JSON, two envelopes as XML — because a diff of two differently-formatted copies of the same
 * content is all noise. A side that does not parse is shown as it was recorded.
 *
 * Two REST sides get two tabs instead, **Response** and **Request**, each over texts built when the
 * tab opened (`rest-diff-text.ts`): a status or request line, the sorted headers, then the body.
 */
export function DiffView({ leftLabel, rightLabel, leftXml, rightXml, rest }: DiffViewProps) {
  const [sideBySide, setSideBySide] = useState(true);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(true);
  const [pane, setPane] = useState<RestPane>('response');
  // The editor area reuses one diff tab for every comparison, so this component is not remounted
  // when a new one opens: start each new comparison on its Response, as a fresh tab would.
  const [seen, setSeen] = useState(rest);
  if (seen !== rest) {
    setSeen(rest);
    setPane('response');
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-hairline px-3 py-2 text-sm">
        <div className="flex min-w-0 items-center gap-2 font-mono text-xs text-fg-muted">
          <span className="truncate" title={leftLabel}>
            {leftLabel}
          </span>
          <span aria-hidden="true">→</span>
          <span className="truncate" title={rightLabel}>
            {rightLabel}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs text-fg-subtle">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={sideBySide}
              onChange={(event) => setSideBySide(event.target.checked)}
              aria-label="Side by side"
            />
            Side by side
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={ignoreWhitespace}
              onChange={(event) => setIgnoreWhitespace(event.target.checked)}
              aria-label="Ignore whitespace"
            />
            Ignore whitespace
          </label>
        </div>
      </div>
      {rest !== undefined && (
        <div className="shrink-0 border-b border-hairline">
          <Tabs label="Compare views" items={REST_PANES} active={pane} onSelect={setPane} />
        </div>
      )}
      <div className="min-h-0 flex-1">
        {rest === undefined ? (
          <DiffXmlEditor
            original={prettyPrintBody(leftXml)}
            modified={prettyPrintBody(rightXml)}
            renderSideBySide={sideBySide}
            ignoreTrimWhitespace={ignoreWhitespace}
          />
        ) : (
          <DiffXmlEditor
            key={pane}
            original={rest[pane].left}
            modified={rest[pane].right}
            renderSideBySide={sideBySide}
            ignoreTrimWhitespace={ignoreWhitespace}
            language="plaintext"
          />
        )}
      </div>
    </div>
  );
}
