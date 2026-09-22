/**
 * One selected frame, opened under the timeline.
 *
 * A text frame is pretty-printed the way the engine's own `prettyFrameText` reads it (JSON, XML,
 * or left alone) in the read-only viewer, with *Raw* for the bytes exactly as they arrived. A binary
 * frame is a hex dump, with *Copy as base64* for handing it to something else. A close frame is its
 * code, what the code means, and the reason. A frame whose payload the session did not keep says
 * so rather than showing an empty viewer that looks like an empty message.
 */
import { useState } from 'react';
import { Copy } from 'lucide-react';
import { prettyFrameText } from '@wirebench/engine/ws';
import { Button } from '../../components/button.js';
import { CodeEditor } from '../../editor/code-editor.js';
import { formatBytes } from '../../lib/format-size.js';
import type { WsFrameContractWire, WsFrameWire } from '../../../shared/wire-types.js';
import { closeCodeMeaning, contractProblemText, formatFrameTime, hexDump } from './ws-format.js';

export interface WsFrameDetailProps {
  readonly frame: WsFrameWire;
}

/** The detail of one frame. */
export function WsFrameDetail({ frame }: WsFrameDetailProps) {
  const [raw, setRaw] = useState(false);

  const header = (
    <p className="shrink-0 px-2 py-1 font-mono text-xs text-fg-subtle">
      {`#${String(frame.index + 1)} · ${frame.direction} · ${frame.opcode} · ${formatFrameTime(frame.at)} · ${formatBytes(frame.size)}`}
    </p>
  );

  let body;
  if (frame.payloadTruncated === true) {
    body = (
      <p className="p-2 text-sm text-fg-subtle">
        This frame’s payload was not kept — it went past the session’s payload budget. Its size is kept.
      </p>
    );
  } else if (frame.opcode === 'close') {
    body = (
      <dl data-testid="ws-frame-close" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 p-2 text-sm">
        <dt className="text-fg-subtle">Code</dt>
        <dd className="font-mono text-fg-default">{frame.close === undefined ? 'none' : String(frame.close.code)}</dd>
        <dt className="text-fg-subtle">Meaning</dt>
        <dd className="text-fg-default">
          {frame.close === undefined ? 'No status code was sent' : closeCodeMeaning(frame.close.code)}
        </dd>
        <dt className="text-fg-subtle">Reason</dt>
        <dd className="text-fg-default">
          {frame.close?.reason === undefined || frame.close.reason === '' ? '—' : frame.close.reason}
        </dd>
      </dl>
    );
  } else if (frame.text !== undefined) {
    const pretty = prettyFrameText(frame.text);
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <label className="flex shrink-0 items-center gap-1 px-2 text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={raw}
            onChange={(event) => {
              setRaw(event.target.checked);
            }}
          />
          Raw
        </label>
        <div className="min-h-0 flex-1">
          <CodeEditor
            ariaLabel="Frame payload"
            readOnly
            language={raw ? 'text' : pretty.language}
            value={raw ? frame.text : pretty.pretty}
          />
        </div>
      </div>
    );
  } else if (frame.base64 !== undefined) {
    const base64 = frame.base64;
    body = (
      <div className="flex min-h-0 flex-1 flex-col gap-1 p-2">
        <div>
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(base64);
            }}
          >
            <Copy size={12} aria-hidden="true" />
            Copy as base64
          </Button>
        </div>
        <pre
          data-testid="ws-frame-hex"
          className="min-h-0 flex-1 overflow-auto font-mono text-xs whitespace-pre text-fg-default select-text"
        >
          {hexDump(base64)}
        </pre>
      </div>
    );
  } else {
    body = <p className="p-2 text-sm text-fg-subtle">This frame carried no payload.</p>;
  }

  return (
    <section
      aria-label="Frame detail"
      data-testid="ws-frame-detail"
      className="flex h-full min-h-0 flex-col border-t border-hairline"
    >
      {header}
      {frame.contract !== undefined && <ContractSection contract={frame.contract} />}
      {body}
    </section>
  );
}

/** The one-line verdict the Contract section opens with. */
function verdict(contract: WsFrameContractWire): string {
  const name = contract.message;
  switch (contract.status) {
    case 'ok':
      return name === undefined ? 'Matches the contract.' : `Matches ${name}.`;
    case 'violation':
      return name === undefined ? 'Does not match the contract.' : `Does not match ${name}.`;
    case 'unmatched':
      return `Not in the contract: ${contract.reason ?? 'no message matches this frame'}.`;
    case 'skipped':
      return `Not checked: ${contract.reason ?? 'skipped'}.`;
    case 'not-checked':
      return 'Not checked — check took too long.';
  }
}

/** How the frame fared against its channel's contract: the matched message, then each problem. */
function ContractSection({ contract }: { readonly contract: WsFrameContractWire }) {
  const problems = contract.problems ?? [];
  return (
    <section
      aria-label="Contract"
      data-testid="ws-frame-contract"
      className="max-h-32 shrink-0 overflow-auto border-b border-hairline px-2 py-1 text-xs"
    >
      <h3 className="font-medium text-fg-muted">Contract</h3>
      <p className={contract.status === 'violation' ? 'text-status-danger' : 'text-fg-default'}>{verdict(contract)}</p>
      {problems.length > 0 && (
        <ul className="mt-0.5 list-disc pl-4 font-mono text-fg-default">
          {problems.map((problem, index) => (
            <li key={`${String(index)}:${problem.path}`}>{contractProblemText(problem)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
