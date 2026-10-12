/**
 * Project rule sets (#342 spec §5): YAML files that pick the built-in rule sets, switch off or
 * re-grade a built-in rule, and add rules of their own as a *target* and a *check* — no JSONPath to
 * write, and nothing a rule-set file can say reaches past the document it lints.
 *
 * A pattern check's regular expression comes from a file and runs against an untrusted document, so
 * it never runs on the caller's thread: every value a pattern is tested against is batched, per
 * pattern, onto the engine's time-bounded regex worker (`xpath/evaluate-async.ts`). A pattern that
 * backtracks past the budget is a finding, not a hang.
 */

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { WirebenchError } from '../../../errors.js';
import { matchRegexManyWithTimeout } from '../../../xpath/evaluate-async.js';
import { HYGIENE_RULES } from './hygiene.js';
import type { LintBuiltinRuleset, LintRulesetFile, LintSeverity } from './model.js';
import { LINT_BUILTIN_RULESETS } from './model.js';
import { OWASP_RULES } from './owasp.js';
import type { JsonPath, LintFunction, LintRule } from './rules.js';
import { MEDIA_TYPES, OPERATIONS, at, isObject } from './rules.js';

/** What a project rule can target, and where each one lives in 2.0 and 3.x documents. */
const TARGETS = {
  info: ['$.info'],
  server: ['$.servers[*]', '$.paths[*].servers[*]', `${OPERATIONS}.servers[*]`],
  operation: [OPERATIONS],
  parameter: [
    '$.paths[*].parameters[*]',
    `${OPERATIONS}.parameters[*]`,
    '$.components.parameters[*]',
    '$.parameters[*]',
  ],
  schema: ['$.components.schemas[*]', '$.definitions[*]'],
  response: [`${OPERATIONS}.responses[*]`, '$.components.responses[*]', '$.responses[*]'],
  media: [...MEDIA_TYPES],
  'security-scheme': ['$.components.securitySchemes[*]', '$.securityDefinitions[*]'],
  tag: ['$.tags[*]'],
} as const satisfies Record<string, readonly string[]>;

type Target = keyof typeof TARGETS;

/** Every target a project rule may name, for the docs and the error message. */
export const LINT_TARGETS = Object.keys(TARGETS) as readonly Target[];

export const LINT_CHECKS = [
  'present',
  'absent',
  'pattern',
  'not-pattern',
  'max-length',
  'min-length',
  'one-of',
] as const;

/** A dotted field name: segments of letters, digits and `_ - $ @`, never empty. */
const FIELD = /^[\w$@-]+(?:\.[\w$@-]+)*$/;

/** A rule id: lower-case letters, digits and hyphens. */
const RULE_ID = /^[a-z0-9][a-z0-9-]*$/;

const MAX_PATTERN = 500;

type ValueKind = 'none' | 'string' | 'number' | 'list';

function kindOf(value: unknown): ValueKind {
  if (value === undefined) return 'none';
  if (typeof value === 'string') return 'string';
  return typeof value === 'number' ? 'number' : 'list';
}

const VALUE_FOR: Readonly<Record<(typeof LINT_CHECKS)[number], ValueKind>> = {
  present: 'none',
  absent: 'none',
  pattern: 'string',
  'not-pattern': 'string',
  'max-length': 'number',
  'min-length': 'number',
  'one-of': 'list',
};

const VALUE_WORDS: Readonly<Record<ValueKind, string>> = {
  none: 'no value',
  string: 'a pattern string',
  number: 'a whole number',
  list: 'a list of values',
};

const customSchema = z
  .object({
    target: z.enum(LINT_TARGETS as [Target, ...Target[]]),
    field: z.string().max(200).regex(FIELD, 'a dotted name of letters, digits, _ - $ and @'),
    check: z.enum(LINT_CHECKS),
    value: z
      .union([z.number().int().nonnegative(), z.string(), z.array(z.union([z.string(), z.number(), z.boolean()]))])
      .optional(),
    severity: z.enum(['error', 'warning', 'info', 'hint']).optional(),
    message: z.string().min(1).max(500).optional(),
    description: z.string().max(500).optional(),
  })
  .strict()
  .superRefine((rule, context) => {
    const want = VALUE_FOR[rule.check];
    if (want !== kindOf(rule.value)) {
      context.addIssue({ code: 'custom', path: ['value'], message: `${rule.check} takes ${VALUE_WORDS[want]}` });
      return;
    }
    if (typeof rule.value !== 'string') return;
    if (rule.value.length > MAX_PATTERN) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: `a pattern is at most ${String(MAX_PATTERN)} characters`,
      });
      return;
    }
    try {
      new RegExp(rule.value);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

const settingSchema = z.enum(['off', 'error', 'warning', 'info', 'hint']);

const fileSchema = z
  .object({
    builtin: z.array(z.enum(LINT_BUILTIN_RULESETS as [LintBuiltinRuleset, ...LintBuiltinRuleset[]])).optional(),
    // Each entry is checked on its own below: a union would only say "invalid input", not which field.
    rules: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

type CustomRule = z.infer<typeof customSchema>;

/** Every built-in rule, by the rule set it belongs to. */
const BUILTINS: Readonly<Record<LintBuiltinRuleset, readonly LintRule[]>> = {
  hygiene: HYGIENE_RULES,
  owasp: OWASP_RULES,
};

const BUILTIN_IDS = new Set([...HYGIENE_RULES, ...OWASP_RULES].map((rule) => rule.id));

function invalid(file: string, message: string): WirebenchError {
  return new WirebenchError('lint-ruleset-invalid', `${file}: ${message}`, { details: { file } });
}

/** The first zod issue as a sentence naming its field: `rules.summary-length.value: …`. */
function invalidIssue(
  file: string,
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
  prefix: readonly string[],
): WirebenchError {
  const issue = issues[0];
  const field = [...prefix, ...(issue?.path ?? [])].map(String).join('.');
  return invalid(file, `${field === '' ? 'the file' : field}: ${issue?.message ?? 'invalid'}`);
}

type PatternVerdict = boolean | { readonly error: string };

/**
 * Batches pattern tests onto the regex worker: one job per pattern for every value tested in the
 * same turn of the event loop. The runner calls every rule function while it walks the document and
 * awaits them afterwards, so one lint costs one worker per distinct pattern, not one per value.
 */
class PatternBatcher {
  private readonly pending = new Map<string, { text: string; resolve: (verdict: PatternVerdict) => void }[]>();
  private scheduled = false;

  private readonly timeoutMs: number | undefined;

  constructor(timeoutMs: number | undefined) {
    this.timeoutMs = timeoutMs;
  }

  test(pattern: string, text: string): Promise<PatternVerdict> {
    return new Promise((resolve) => {
      const queue = this.pending.get(pattern) ?? [];
      queue.push({ text, resolve });
      this.pending.set(pattern, queue);
      if (!this.scheduled) {
        this.scheduled = true;
        setImmediate(() => {
          void this.flush();
        });
      }
    });
  }

  private async flush(): Promise<void> {
    this.scheduled = false;
    const batches = [...this.pending];
    this.pending.clear();
    await Promise.all(
      batches.map(async ([pattern, queue]) => {
        const texts = queue.map((entry) => entry.text);
        const result = await matchRegexManyWithTimeout(
          pattern,
          texts,
          this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs },
        );
        for (const [index, entry] of queue.entries()) {
          entry.resolve(result.kind === 'matched' ? (result.matches[index] ?? false) : { error: result.message });
        }
      }),
    );
  }
}

function lengthOf(value: unknown): number | undefined {
  return typeof value === 'string' || Array.isArray(value) ? value.length : undefined;
}

function missing(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/** The value at a dotted field inside `input`, or `undefined` when any step is missing. */
function fieldValue(input: unknown, segments: readonly string[]): unknown {
  let value = input;
  for (const segment of segments) value = isObject(value) ? value[segment] : undefined;
  return value;
}

/** Why `value` breaks `rule`, or `undefined` when it does not (patterns aside). */
function plainFailure(rule: CustomRule, value: unknown): string | undefined {
  const limit = typeof rule.value === 'number' ? rule.value : 0;
  const length = lengthOf(value);
  switch (rule.check) {
    case 'present':
      return missing(value) ? `${rule.field} is missing` : undefined;
    case 'absent':
      return value === undefined ? undefined : `${rule.field} must not be set`;
    case 'max-length':
      return length !== undefined && length > limit ? `${rule.field} is longer than ${String(limit)}` : undefined;
    case 'min-length':
      return length !== undefined && length < limit ? `${rule.field} is shorter than ${String(limit)}` : undefined;
    case 'one-of': {
      const allowed = Array.isArray(rule.value) ? rule.value : [];
      return value === undefined || allowed.some((entry) => entry === value)
        ? undefined
        : `${rule.field} is not one of ${allowed.map(String).join(', ')}`;
    }
    case 'pattern':
    case 'not-pattern':
      return undefined;
  }
}

/** The function one project rule checks with. */
function checkOf(rule: CustomRule, patterns: PatternBatcher): LintFunction {
  const segments = rule.field.split('.');
  return async (input, _options, context) => {
    if (!isObject(input)) return [];
    const value = fieldValue(input, segments);
    const here: JsonPath = value === undefined ? context.path : [...context.path, ...segments];
    let failure = plainFailure(rule, value);
    if ((rule.check === 'pattern' || rule.check === 'not-pattern') && typeof value === 'string') {
      const pattern = String(rule.value);
      const verdict = await patterns.test(pattern, value);
      if (typeof verdict !== 'boolean') return [at(here, `${rule.field} could not be checked: ${verdict.error}`)];
      if (rule.check === 'pattern' && !verdict) failure = `${rule.field} does not match /${pattern}/`;
      if (rule.check === 'not-pattern' && verdict) failure = `${rule.field} matches /${pattern}/`;
    }
    return failure === undefined ? [] : [at(here, rule.message ?? failure)];
  };
}

const CHECK_WORDS: Readonly<Record<CustomRule['check'], string>> = {
  present: 'is set',
  absent: 'is not set',
  pattern: 'matches a pattern',
  'not-pattern': 'does not match a pattern',
  'max-length': 'is not too long',
  'min-length': 'is not too short',
  'one-of': 'is one of the allowed values',
};

/** Options for {@link planLintRules}. */
export interface PlanLintRulesOptions {
  /** How long one pattern may run over all the values it is tested against; the worker's default otherwise. */
  readonly patternTimeoutMs?: number;
}

/**
 * The rules a lint runs: the chosen built-ins with their overrides, then the project's own rules.
 * Files apply in the order given, a later one winning (spec §5).
 *
 * @throws WirebenchError `lint-ruleset-invalid`, naming the file and the field
 */
export function planLintRules(
  files: readonly LintRulesetFile[],
  options: PlanLintRulesOptions = {},
): readonly LintRule[] {
  let builtin: readonly LintBuiltinRuleset[] = LINT_BUILTIN_RULESETS;
  const settings = new Map<string, LintSeverity | 'off'>();
  const custom = new Map<string, { rule: CustomRule; file: string }>();

  for (const file of files) {
    let raw: unknown;
    try {
      raw = parseYaml(file.text) ?? {};
    } catch (error) {
      throw invalid(file.name, `not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) throw invalidIssue(file.name, parsed.error.issues, []);
    if (parsed.data.builtin !== undefined) builtin = parsed.data.builtin;
    for (const [id, entry] of Object.entries(parsed.data.rules ?? {})) {
      if (!RULE_ID.test(id)) {
        throw invalid(file.name, `rules.${id}: a rule id is lower-case letters, digits and hyphens`);
      }
      const checked = typeof entry === 'string' ? settingSchema.safeParse(entry) : customSchema.safeParse(entry);
      if (!checked.success) throw invalidIssue(file.name, checked.error.issues, ['rules', id]);
      const definition = checked.data;
      if (typeof definition === 'string') {
        if (!BUILTIN_IDS.has(id) && !custom.has(id)) {
          throw invalid(file.name, `rules.${id}: no built-in or project rule is called "${id}"`);
        }
        settings.set(id, definition);
      } else {
        if (BUILTIN_IDS.has(id)) {
          throw invalid(file.name, `rules.${id}: "${id}" is a built-in rule; set it to a severity or off`);
        }
        custom.set(id, { rule: definition, file: file.name });
        settings.delete(id);
      }
    }
  }

  const patterns = new PatternBatcher(options.patternTimeoutMs);
  const rules: LintRule[] = [];
  const add = (rule: LintRule): void => {
    const setting = settings.get(rule.id);
    if (setting === 'off') return;
    rules.push(setting === undefined ? rule : { ...rule, severity: setting });
  };
  for (const name of LINT_BUILTIN_RULESETS) {
    if (builtin.includes(name)) BUILTINS[name].forEach(add);
  }
  for (const [id, { rule, file }] of custom) {
    add({
      id,
      severity: rule.severity ?? 'warning',
      ruleset: file,
      description: rule.description ?? `${rule.target} ${rule.field} ${CHECK_WORDS[rule.check]}`,
      body: { given: [...TARGETS[rule.target]], then: { function: checkOf(rule, patterns) } },
    });
  }
  return rules;
}
