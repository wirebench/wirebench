import { useState } from 'react';
import { DiffXmlEditor } from '../../editor/diff-xml-editor.js';
import { prettyPrintXml } from '../../editor/xml-language.js';

export interface DiffViewProps {
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly leftXml: string;
  readonly rightXml: string;
}

/**
 * A read-only diff tab (`editors.ts` `kind: 'diff'`): two envelopes, pretty-printed, side by
 * side in Monaco's `DiffEditor`, with a header naming both sides and toggles for layout and
 * whitespace.
 */
export function DiffView({ leftLabel, rightLabel, leftXml, rightXml }: DiffViewProps) {
  const [sideBySide, setSideBySide] = useState(true);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(true);

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
      <div className="min-h-0 flex-1">
        <DiffXmlEditor
          original={prettyPrintXml(leftXml)}
          modified={prettyPrintXml(rightXml)}
          renderSideBySide={sideBySide}
          ignoreTrimWhitespace={ignoreWhitespace}
        />
      </div>
    </div>
  );
}
