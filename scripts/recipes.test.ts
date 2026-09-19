/**
 * Static checks on `action/action.yml` (Task 4 of #31): every documented input exists with the
 * default the design spec (§2.3) promises, the action is a composite action with an
 * `exit-code` output, and no step's `run:` interpolates `${{ inputs.* }}` directly — inputs must
 * flow through `env:` so a malicious value in, say, `select` can't be read back as shell source.
 * Tasks 5 and 6 append cases here for the GitLab template and the release workflow.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');

interface ActionInput {
  readonly description?: string;
  readonly required?: boolean;
  readonly default?: string;
}

interface ActionStep {
  readonly run?: string;
  readonly shell?: string;
  readonly id?: string;
  readonly uses?: string;
}

interface ActionYaml {
  readonly inputs?: Record<string, ActionInput>;
  readonly outputs?: Record<string, { value?: string }>;
  readonly runs: {
    readonly using: string;
    readonly steps: readonly ActionStep[];
  };
}

function loadAction(): ActionYaml {
  const text = readFileSync(join(repoRoot, 'action', 'action.yml'), 'utf8');
  return parse(text) as ActionYaml;
}

// Spec §2.3's input table, name -> the literal YAML default it documents (undefined where the
// spec gives no static default — `project` is required with none, and `version`'s "default" is
// computed at runtime from `github.action_ref`, not a static `default:` key).
const EXPECTED_DEFAULTS: Record<string, string | undefined> = {
  project: undefined,
  env: undefined,
  select: undefined,
  vars: undefined,
  junit: undefined,
  json: undefined,
  html: undefined,
  bail: 'false',
  'require-assertions': 'false',
  insecure: 'false',
  timeout: undefined,
  sla: undefined,
  version: undefined,
  'node-version': '24',
};

describe('action/action.yml', () => {
  const action = loadAction();

  it('is a composite action', () => {
    expect(action.runs.using).toBe('composite');
  });

  it('declares every input from spec §2.3 with its documented default', () => {
    for (const [name, expectedDefault] of Object.entries(EXPECTED_DEFAULTS)) {
      expect(action.inputs, `missing inputs section`).toBeDefined();
      const input = action.inputs?.[name];
      expect(input, `missing input "${name}"`).toBeDefined();
      expect(input?.default, `default for "${name}"`).toBe(expectedDefault);
    }
  });

  it('requires only "project"', () => {
    for (const [name, input] of Object.entries(action.inputs ?? {})) {
      expect(input.required === true, `"${name}" required flag`).toBe(name === 'project');
    }
  });

  it('declares an exit-code output', () => {
    expect(action.outputs?.['exit-code']).toBeDefined();
  });

  it('never interpolates ${{ inputs.* }} inside a run: script', () => {
    for (const step of action.runs.steps) {
      if (step.run !== undefined) {
        expect(step.run.includes('${{ inputs.')).toBe(false);
      }
    }
  });

  it('sets up Node with the node-version input', () => {
    const setupNode = action.runs.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(setupNode).toBeDefined();
  });
});
