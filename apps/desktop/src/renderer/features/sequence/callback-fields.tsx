/**
 * A callback assertion's fields (callback-assertion spec §5): which catch URL, how long, what picks
 * the capture, and what is checked on it. Every edit replaces the assertion whole; main validates.
 */
import type { StepAssertionWire } from '../../../shared/wire-types.js';
import { useWebhooksStore } from '../../state/webhooks.js';
import { withinMsOf } from './callback-text.js';
import { CheckEditor, type CheckFields } from './check-editor.js';
import { CheckField, CommitInput, FieldRow, SelectField } from './step-fields.js';

type Callback = Extract<StepAssertionWire, { type: 'callback' }>;
type Match = Callback['match'];
type Header = NonNullable<Match['headers']>[number];
type Body = NonNullable<Match['body']>;
type Expect = Callback['expect'][number];

const METHODS: readonly { value: string; label: string }[] = [
  { value: '', label: 'Any method' },
  { value: 'POST', label: 'POST' },
  { value: 'PUT', label: 'PUT' },
  { value: 'PATCH', label: 'PATCH' },
  { value: 'GET', label: 'GET' },
  { value: 'DELETE', label: 'DELETE' },
];

const EXPECT_KINDS = [
  { value: 'body', label: 'Body' },
  { value: 'header', label: 'Header' },
  { value: 'signature', label: 'Signature verified' },
] as const;
type ExpectKind = (typeof EXPECT_KINDS)[number]['value'];

const BODY_LANGUAGES = [
  { value: 'jsonpath', label: 'JSONPath' },
  { value: 'xpath', label: 'XPath' },
] as const;

const DEFAULT_BODY: Body = { language: 'jsonpath', path: '$', exists: true };
const DEFAULT_HEADER: Header = { name: 'Content-Type', exists: true };
const DEFAULT_EXPECT: Record<ExpectKind, Expect> = {
  body: { body: DEFAULT_BODY },
  header: { header: DEFAULT_HEADER },
  signature: { signature: 'verified' },
};

function kindOf(check: Expect): ExpectKind {
  return 'body' in check ? 'body' : 'header' in check ? 'header' : 'signature';
}

/** The method options, plus the stored method when a file names one the list does not offer. */
function methodOptions(method: string): readonly { value: string; label: string }[] {
  return METHODS.some((option) => option.value === method) ? METHODS : [...METHODS, { value: method, label: method }];
}

/** A callback header or body check as zod reads it: the check fields may be present and `undefined`. */
interface CheckHolder {
  readonly equals?: string | undefined;
  readonly matches?: string | undefined;
  readonly exists?: boolean | undefined;
}

/** `holder` without its check fields, then `fields`: exactly one check stays. */
function withCheck<T extends CheckHolder>(holder: T, fields: CheckFields): Omit<T, keyof CheckHolder> & CheckFields {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit them
  const { equals, matches, exists, ...rest } = holder;
  return { ...rest, ...fields };
}

/** `match` with `key` set, or without it when `value` is `undefined`. */
function withMatch<K extends keyof Match>(match: Match, key: K, value: Match[K] | undefined): Match {
  const next: Record<string, unknown> = { ...match };
  if (value === undefined) Reflect.deleteProperty(next, key);
  else next[key] = value;
  return next;
}

/** `match` without either path field, then the path as exact or as a pattern. */
function withPath(match: Match, text: string, pattern: boolean): Match {
  const bare = withMatch(withMatch(match, 'path', undefined), 'pathMatches', undefined);
  return text === '' ? bare : withMatch(bare, pattern ? 'pathMatches' : 'path', text);
}

export interface CallbackFieldsProps {
  readonly assertion: Callback;
  readonly onChange: (next: Callback) => void;
}

export function CallbackFields({ assertion, onChange }: CallbackFieldsProps) {
  const hooks = useWebhooksStore((state) => state.hooks);
  const { match } = assertion;
  const { body } = match;
  const method = match.method ?? '';
  const pattern = match.pathMatches !== undefined;
  const pathText = match.pathMatches ?? match.path ?? '';
  const headers = match.headers ?? [];
  const setMatch = (next: Match): void => onChange({ ...assertion, match: next });
  const setHeaders = (next: Header[]): void =>
    setMatch(withMatch(match, 'headers', next.length === 0 ? undefined : next));
  const setBody = (next: Body | undefined): void => setMatch(withMatch(match, 'body', next));
  const setExpect = (next: Expect[]): void => onChange({ ...assertion, expect: next });

  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <CommitInput
          label="Catch URL"
          testId="sequence-callback-catch-url"
          className="w-40"
          list="sequence-callback-catch-urls"
          value={assertion.catchUrl}
          onCommit={(catchUrl) => onChange({ ...assertion, catchUrl: catchUrl.trim() })}
        />
        <datalist id="sequence-callback-catch-urls">
          {hooks.map((hook) => (
            <option key={hook.id} value={hook.name} />
          ))}
        </datalist>
        <CommitInput
          label="Within (s)"
          testId="sequence-callback-within"
          className="w-16"
          value={String(assertion.withinMs / 1000)}
          onCommit={(text) => {
            const withinMs = withinMsOf(text);
            if (withinMs !== undefined) onChange({ ...assertion, withinMs });
          }}
        />
        <SelectField
          label="Method"
          testId="sequence-callback-method"
          value={method}
          options={methodOptions(method)}
          onChange={(next) => setMatch(withMatch(match, 'method', next === '' ? undefined : next))}
        />
        <CommitInput
          label="Path"
          testId="sequence-callback-path"
          monospace
          className="min-w-32 flex-1"
          value={pathText}
          placeholder="/events"
          onCommit={(text) => setMatch(withPath(match, text, pattern))}
        />
        <CheckField
          label="Regex"
          testId="sequence-callback-path-regex"
          checked={pattern}
          onChange={(checked) => setMatch(withPath(match, pathText, checked))}
        />
      </div>

      <ul>
        {headers.map((header, index) => {
          const put = (next: Header): void => setHeaders(headers.map((h, i) => (i === index ? next : h)));
          return (
            <FieldRow
              key={index}
              testId="sequence-callback-header-row"
              removeLabel="Remove header match"
              onRemove={() => setHeaders(headers.filter((_, i) => i !== index))}
            >
              <CommitInput
                label="Header name"
                testId="sequence-callback-header-row-name"
                className="w-40"
                value={header.name}
                onCommit={(name) => put({ ...header, name })}
              />
              <CheckEditor
                value={header}
                testId="sequence-callback-header-row"
                onChange={(fields) => put(withCheck(header, fields))}
              />
            </FieldRow>
          );
        })}
        {body !== undefined && (
          <FieldRow
            testId="sequence-callback-body-row"
            removeLabel="Remove body match"
            onRemove={() => setBody(undefined)}
          >
            <SelectField
              label="Body language"
              testId="sequence-callback-body-language"
              value={body.language}
              options={BODY_LANGUAGES}
              onChange={(language) => setBody({ ...body, language })}
            />
            <CommitInput
              label="Body path"
              testId="sequence-callback-body-path"
              monospace
              className="min-w-32 flex-1"
              value={body.path}
              onCommit={(path) => setBody({ ...body, path })}
            />
            <CheckEditor
              value={body}
              testId="sequence-callback-body"
              onChange={(fields) => setBody(withCheck(body, fields))}
            />
          </FieldRow>
        )}
      </ul>
      <div className="flex gap-3">
        <button
          type="button"
          data-testid="sequence-callback-add-header"
          className="text-sm text-accent hover:underline"
          onClick={() => setHeaders([...headers, DEFAULT_HEADER])}
        >
          Match a header
        </button>
        {body === undefined && (
          <button
            type="button"
            data-testid="sequence-callback-add-body"
            className="text-sm text-accent hover:underline"
            onClick={() => setBody(DEFAULT_BODY)}
          >
            Match the body
          </button>
        )}
      </div>

      <ul>
        {assertion.expect.map((check, index) => {
          const put = (next: Expect): void => setExpect(assertion.expect.map((c, i) => (i === index ? next : c)));
          return (
            <FieldRow
              key={index}
              testId="sequence-callback-expect-row"
              removeLabel="Remove check"
              onRemove={() => setExpect(assertion.expect.filter((_, i) => i !== index))}
            >
              <SelectField
                label="Expect"
                testId="sequence-callback-expect-kind"
                value={kindOf(check)}
                options={EXPECT_KINDS}
                onChange={(kind) => put(DEFAULT_EXPECT[kind])}
              />
              {'body' in check && (
                <>
                  <SelectField
                    label="Language"
                    testId="sequence-callback-expect-row-language"
                    value={check.body.language}
                    options={BODY_LANGUAGES}
                    onChange={(language) => put({ body: { ...check.body, language } })}
                  />
                  <CommitInput
                    label="Path"
                    testId="sequence-callback-expect-row-path"
                    monospace
                    className="min-w-32 flex-1"
                    value={check.body.path}
                    onCommit={(path) => put({ body: { ...check.body, path } })}
                  />
                  <CheckEditor
                    value={check.body}
                    testId="sequence-callback-expect-row"
                    onChange={(fields) => put({ body: withCheck(check.body, fields) })}
                  />
                </>
              )}
              {'header' in check && (
                <>
                  <CommitInput
                    label="Header name"
                    testId="sequence-callback-expect-row-name"
                    className="w-40"
                    value={check.header.name}
                    onCommit={(name) => put({ header: { ...check.header, name } })}
                  />
                  <CheckEditor
                    value={check.header}
                    testId="sequence-callback-expect-row"
                    onChange={(fields) => put({ header: withCheck(check.header, fields) })}
                  />
                </>
              )}
            </FieldRow>
          );
        })}
      </ul>
      <button
        type="button"
        data-testid="sequence-callback-add-expect"
        className="self-start text-sm text-accent hover:underline"
        onClick={() => setExpect([...assertion.expect, DEFAULT_EXPECT.body])}
      >
        Add a check
      </button>
    </div>
  );
}
