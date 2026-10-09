/**
 * One canned response of a mock operation (#59): its status, delay, headers, the conditions under
 * which it is picked, its place in a scenario, and its body. Each committed field is one
 * `update-mock-response`, which main checks against the rules a response file is held to; a refused
 * edit is reported and the field snaps back.
 */
import { useEffect, useRef, useState } from 'react';
import { CodeEditor } from '../../editor/code-editor.js';
import type {
  MockBodyLanguageWire,
  MockDispatchWire,
  MockHeaderWire,
  MockMatchWire,
  MockResponsePatch,
  MockResponseWire,
} from '../../../shared/wire-types.js';
import { CommitInput, FieldRow, SelectField } from '../sequence/step-fields.js';

const BODY_LANGUAGES: readonly { value: MockBodyLanguageWire; label: string }[] = [
  { value: 'xml', label: 'XML' },
  { value: 'json', label: 'JSON' },
  { value: 'text', label: 'Text' },
  { value: 'none', label: 'No body' },
];

type MatchSource = 'body-xpath' | 'body-jsonpath' | 'query' | 'header' | 'path';

const MATCH_SOURCES: readonly { value: MatchSource; label: string }[] = [
  { value: 'body-xpath', label: 'Body (XPath)' },
  { value: 'body-jsonpath', label: 'Body (JSONPath)' },
  { value: 'query', label: 'Query parameter' },
  { value: 'header', label: 'Header' },
  { value: 'path', label: 'Path parameter' },
];

type MatchCheck = 'exists' | 'missing' | 'equals' | 'matches';

const MATCH_CHECKS: readonly { value: MatchCheck; label: string }[] = [
  { value: 'exists', label: 'is present' },
  { value: 'missing', label: 'is absent' },
  { value: 'equals', label: 'equals' },
  { value: 'matches', label: 'matches' },
];

function sourceOf(match: MockMatchWire): MatchSource {
  return match.from === 'body' ? (match.language === 'xpath' ? 'body-xpath' : 'body-jsonpath') : match.from;
}

function checkOf(match: MockMatchWire): MatchCheck {
  if (match.equals !== undefined) return 'equals';
  if (match.matches !== undefined) return 'matches';
  return match.exists === false ? 'missing' : 'exists';
}

/** `match` read from `source` instead, keeping its expression or name and its check. */
function withSource(match: MockMatchWire, source: MatchSource): MockMatchWire {
  const check = { equals: match.equals, matches: match.matches, exists: match.exists };
  const target = match.from === 'body' ? match.expression : match.name;
  if (source === 'body-xpath' || source === 'body-jsonpath') {
    return { from: 'body', language: source === 'body-xpath' ? 'xpath' : 'jsonpath', expression: target, ...check };
  }
  return { from: source, name: target, ...check };
}

function withCheck(match: MockMatchWire, check: MatchCheck, value: string): MockMatchWire {
  const base =
    match.from === 'body'
      ? {
          from: 'body' as const,
          language: match.language,
          expression: match.expression,
          ...(match.namespaces !== undefined ? { namespaces: match.namespaces } : {}),
        }
      : { from: match.from, name: match.name };
  switch (check) {
    case 'exists':
      return base;
    case 'missing':
      return { ...base, exists: false };
    case 'equals':
      return { ...base, equals: value };
    case 'matches':
      return { ...base, matches: value };
  }
}

function MatchList({
  match,
  dispatch,
  onChange,
}: {
  readonly match: readonly MockMatchWire[];
  readonly dispatch: MockDispatchWire;
  readonly onChange: (match: MockMatchWire[]) => void;
}) {
  const replace = (index: number, next: MockMatchWire): void => {
    onChange(match.map((condition, at) => (at === index ? next : condition)));
  };
  return (
    <div data-testid="mock-match">
      {dispatch !== 'match' && match.length > 0 && (
        <p className="text-xs text-fg-subtle">
          These conditions are used only while the operation dispatches by match.
        </p>
      )}
      {match.length === 0 && (
        <p className="text-xs text-fg-subtle">
          No conditions: under match dispatch this response is a candidate for every request.
        </p>
      )}
      <ul>
        {match.map((condition, index) => {
          const check = checkOf(condition);
          const target = condition.from === 'body' ? condition.expression : condition.name;
          return (
            <FieldRow
              key={String(index)}
              testId="mock-match-row"
              removeLabel={`Remove condition ${String(index + 1)}`}
              onRemove={() => onChange(match.filter((_, at) => at !== index))}
            >
              <SelectField
                label="Source"
                value={sourceOf(condition)}
                options={MATCH_SOURCES}
                onChange={(source) => replace(index, withSource(condition, source))}
              />
              <CommitInput
                label={condition.from === 'body' ? 'Expression' : 'Name'}
                testId="mock-match-target"
                className="w-56"
                monospace
                placeholder={
                  condition.from === 'body' ? (condition.language === 'xpath' ? '//ord:sku' : '$.qty') : 'name'
                }
                value={target}
                onCommit={(value) =>
                  replace(
                    index,
                    condition.from === 'body' ? { ...condition, expression: value } : { ...condition, name: value },
                  )
                }
              />
              <SelectField
                label="Check"
                value={check}
                options={MATCH_CHECKS}
                onChange={(next) =>
                  replace(index, withCheck(condition, next, condition.equals ?? condition.matches ?? ''))
                }
              />
              {(check === 'equals' || check === 'matches') && (
                <CommitInput
                  label={check === 'equals' ? 'Value' : 'Regular expression'}
                  testId="mock-match-value"
                  className="w-40"
                  monospace={check === 'matches'}
                  value={condition.equals ?? condition.matches ?? ''}
                  onCommit={(value) => replace(index, withCheck(condition, check, value))}
                />
              )}
            </FieldRow>
          );
        })}
      </ul>
      <button
        type="button"
        data-testid="mock-match-add"
        disabled={match.length >= 20}
        className="mt-1 text-sm text-accent hover:underline disabled:opacity-40"
        onClick={() => onChange([...match, { from: 'query', name: 'param', equals: 'value' }])}
      >
        Add condition
      </button>
    </div>
  );
}

function HeaderList({
  headers,
  onChange,
}: {
  readonly headers: readonly MockHeaderWire[];
  readonly onChange: (headers: MockHeaderWire[]) => void;
}) {
  const replace = (index: number, next: MockHeaderWire): void => {
    onChange(headers.map((header, at) => (at === index ? next : header)));
  };
  return (
    <div data-testid="mock-headers">
      <ul>
        {headers.map((header, index) => (
          <FieldRow
            key={String(index)}
            testId="mock-header-row"
            removeLabel={`Remove header ${header.name}`}
            onRemove={() => onChange(headers.filter((_, at) => at !== index))}
          >
            <CommitInput
              label="Header name"
              className="w-48"
              value={header.name}
              onCommit={(name) => replace(index, { ...header, name: name.trim() })}
            />
            <CommitInput
              label="Header value"
              className="min-w-0 flex-1"
              value={header.value}
              onCommit={(value) => replace(index, { ...header, value })}
            />
          </FieldRow>
        ))}
      </ul>
      <button
        type="button"
        data-testid="mock-header-add"
        className="mt-1 text-sm text-accent hover:underline"
        onClick={() => onChange([...headers, { name: 'X-Header', value: '' }])}
      >
        Add header
      </button>
    </div>
  );
}

/** How long typing in the body waits before it is committed. */
const BODY_COMMIT_DELAY_MS = 600;

/**
 * The body, edited in its own language. Typing is committed after a pause and when the editor goes,
 * rather than on every keystroke: each commit is one validated `update-mock-response`.
 */
function BodyEditor({
  responseId,
  language,
  text,
  onCommit,
}: {
  readonly responseId: string;
  readonly language: Exclude<MockBodyLanguageWire, 'none'>;
  readonly text: string;
  readonly onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(text);
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; text: string } | undefined>(undefined);
  const commit = useRef(onCommit);
  commit.current = onCommit;

  useEffect(() => {
    setDraft(text);
  }, [text, responseId]);

  useEffect(
    () => () => {
      if (pending.current !== undefined) {
        clearTimeout(pending.current.timer);
        commit.current(pending.current.text);
        pending.current = undefined;
      }
    },
    [responseId],
  );

  return (
    <div data-testid="mock-body-editor" className="h-64 min-h-0">
      <CodeEditor
        value={draft}
        language={language}
        ariaLabel="Response body"
        onChange={(next) => {
          setDraft(next);
          if (pending.current !== undefined) clearTimeout(pending.current.timer);
          pending.current = {
            text: next,
            timer: setTimeout(() => {
              pending.current = undefined;
              commit.current(next);
            }, BODY_COMMIT_DELAY_MS),
          };
        }}
      />
    </div>
  );
}

export interface MockResponseEditorProps {
  readonly response: MockResponseWire;
  readonly dispatch: MockDispatchWire;
  readonly onPatch: (patch: MockResponsePatch) => void;
}

export function MockResponseEditor({ response, dispatch, onPatch }: MockResponseEditorProps) {
  const scenario = response.scenario;
  const setScenario = (field: 'name' | 'state' | 'next', value: string): void => {
    const next = { name: scenario?.name ?? '', state: scenario?.state, next: scenario?.next, [field]: value.trim() };
    if (next.name === '') {
      onPatch({ scenario: null });
      return;
    }
    onPatch({
      scenario: {
        name: next.name,
        ...(next.state !== undefined && next.state !== '' ? { state: next.state } : {}),
        ...(next.next !== undefined && next.next !== '' ? { next: next.next } : {}),
      },
    });
  };

  return (
    <div data-testid="mock-response-editor" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <CommitInput
          label="Response name"
          testId="mock-response-name"
          className="w-56"
          value={response.name}
          onCommit={(name) => {
            if (name.trim() !== '') onPatch({ name: name.trim() });
          }}
        />
        <label className="flex items-center gap-1 text-sm text-fg-muted">
          Status
          <CommitInput
            label="Status"
            testId="mock-response-status"
            className="w-20"
            value={String(response.status)}
            onCommit={(value) => {
              const status = Number(value);
              if (Number.isInteger(status)) onPatch({ status });
            }}
          />
        </label>
        <label className="flex items-center gap-1 text-sm text-fg-muted">
          Delay (ms)
          <CommitInput
            label="Delay (ms)"
            testId="mock-response-delay"
            className="w-24"
            value={String(response.delayMs)}
            onCommit={(value) => {
              const delayMs = value.trim() === '' ? 0 : Number(value);
              if (Number.isInteger(delayMs)) onPatch({ delayMs });
            }}
          />
        </label>
        <SelectField
          label="Body"
          testId="mock-response-body-language"
          value={response.body}
          options={BODY_LANGUAGES}
          onChange={(body) => onPatch({ body })}
        />
      </div>

      <section>
        <h4 className="text-sm font-medium text-fg-default">Headers</h4>
        <HeaderList headers={response.headers} onChange={(headers) => onPatch({ headers })} />
      </section>

      <section>
        <h4 className="text-sm font-medium text-fg-default">Match conditions</h4>
        <p className="text-xs text-fg-subtle">Every condition must hold for this response to be picked.</p>
        <MatchList match={response.match} dispatch={dispatch} onChange={(match) => onPatch({ match })} />
      </section>

      <section>
        <h4 className="text-sm font-medium text-fg-default">Scenario</h4>
        <p className="text-xs text-fg-subtle">
          A response with a state is a candidate only while its scenario is in that state; sending it moves the scenario
          to the next state. Every scenario starts in <code className="font-mono">Started</code>.
        </p>
        <div className="flex flex-wrap items-center gap-2 py-1">
          <CommitInput
            label="Scenario name"
            testId="mock-scenario-name"
            className="w-40"
            placeholder="Scenario"
            value={scenario?.name ?? ''}
            onCommit={(value) => setScenario('name', value)}
          />
          <CommitInput
            label="Only in state"
            testId="mock-scenario-state"
            className="w-36"
            placeholder="Any state"
            value={scenario?.state ?? ''}
            onCommit={(value) => setScenario('state', value)}
          />
          <CommitInput
            label="Then move to"
            testId="mock-scenario-next"
            className="w-36"
            placeholder="Stay"
            value={scenario?.next ?? ''}
            onCommit={(value) => setScenario('next', value)}
          />
        </div>
      </section>

      <section className="flex flex-col gap-1">
        <h4 className="text-sm font-medium text-fg-default">Body</h4>
        {response.body === 'none' ? (
          <p className="text-sm text-fg-subtle">This response sends no body.</p>
        ) : (
          <>
            <p className="text-xs text-fg-subtle">Sent exactly as written: nothing in it is expanded.</p>
            <BodyEditor
              responseId={response.id}
              language={response.body}
              text={response.bodyText}
              onCommit={(bodyText) => {
                if (bodyText !== response.bodyText) onPatch({ bodyText });
              }}
            />
          </>
        )}
      </section>
    </div>
  );
}
