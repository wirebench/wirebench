/**
 * Static checks on `action/action.yml` (Task 4 of #31): every documented input exists with the
 * default the design spec (§2.3) promises, the action is a composite action with an
 * `exit-code` output, and no step's `run:` interpolates `${{ inputs.* }}` directly — inputs must
 * flow through `env:` so a malicious value in, say, `select` can't be read back as shell source.
 * Tasks 5 and 6 append cases here for the GitLab template and the release workflow.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

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

/**
 * Runs the composite step's actual `run:` script (not a reimplementation of its version logic)
 * against a fake `npx` that records its argv instead of hitting the network, so these cases catch
 * a regression in the real script the way the other unit tests can't — YAML parsing alone can't
 * see what a shell conditional does with its input.
 */
describe('action/action.yml run script: version resolution', () => {
  const runScript = (() => {
    const action = loadAction();
    const step = action.runs.steps.find((candidate) => candidate.id === 'run');
    if (step?.run === undefined) {
      throw new Error('action.yml has no step with id "run"');
    }
    return step.run;
  })();

  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** Executes the run script with the given env, returning the fake npx's captured argv and the exit-code output. */
  function runWithFakeNpx(env: Readonly<Record<string, string>>): { npxArgs: string[]; exitCode: string | undefined } {
    const dir = mkdtempSync(join(tmpdir(), 'wirebench-recipes-test-'));
    tempDirs.push(dir);

    const binDir = join(dir, 'bin');
    const capturePath = join(dir, 'npx-args.txt');
    const githubOutput = join(dir, 'github-output.txt');
    const scriptPath = join(dir, 'run.sh');

    execFileSync('mkdir', ['-p', binDir]);
    // A fake `npx` ahead of the real one on PATH: it records its own argv (one per line) and
    // exits 0, so the script under test never touches the network.
    writeFileSync(join(binDir, 'npx'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${capturePath}"\nexit 0\n`);
    chmodSync(join(binDir, 'npx'), 0o755);
    writeFileSync(scriptPath, `#!/usr/bin/env bash\n${runScript}`);
    chmodSync(scriptPath, 0o755);
    writeFileSync(githubOutput, '');

    const defaults: Record<string, string> = {
      WB_PROJECT: './project',
      WB_ENV: '',
      WB_SELECT: '',
      WB_VARS: '',
      WB_JUNIT: '',
      WB_JSON: '',
      WB_HTML: '',
      WB_BAIL: 'false',
      WB_REQUIRE_ASSERTIONS: 'false',
      WB_INSECURE: 'false',
      WB_TIMEOUT: '',
      WB_SLA: '',
      WB_VERSION: '',
      WB_NODE_VERSION: '24',
      WB_ACTION_REF: '',
      WB_PACKAGES: '',
    };

    execFileSync('bash', [scriptPath], {
      env: { ...defaults, ...env, PATH: `${binDir}:${process.env['PATH']}`, GITHUB_OUTPUT: githubOutput },
      stdio: 'pipe',
    });

    const npxArgs = readFileSync(capturePath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
    const outputMatch = readFileSync(githubOutput, 'utf8').match(/^exit-code=(.*)$/m);
    return { npxArgs, exitCode: outputMatch?.[1] };
  }

  it('strips the leading v from an exact version tag', () => {
    const { npxArgs, exitCode } = runWithFakeNpx({ WB_ACTION_REF: 'v2.3.0' });
    expect(npxArgs).toContain('@wirebench/cli@2.3.0');
    expect(exitCode).toBe('0');
  });

  it('keeps a pre-release ref (v2.3.0-rc.1) instead of falling back to latest', () => {
    const { npxArgs } = runWithFakeNpx({ WB_ACTION_REF: 'v2.3.0-rc.1' });
    expect(npxArgs).toContain('@wirebench/cli@2.3.0-rc.1');
    expect(npxArgs.some((arg) => arg.includes('@latest'))).toBe(false);
  });

  it('falls back to latest for a non-version ref (e.g. a branch name)', () => {
    const { npxArgs } = runWithFakeNpx({ WB_ACTION_REF: 'main' });
    expect(npxArgs).toContain('@wirebench/cli@latest');
  });

  it('WB_VERSION overrides the ref entirely', () => {
    const { npxArgs } = runWithFakeNpx({ WB_ACTION_REF: 'v2.3.0-rc.1', WB_VERSION: '9.9.9' });
    expect(npxArgs).toContain('@wirebench/cli@9.9.9');
  });
});

/**
 * Static checks on `templates/gitlab/wirebench.gitlab-ci.yml` (Task 5 of #31): the hidden job
 * exists with the image, entrypoint, variables and artifacts spec §2.4 promises, and its
 * `script` is the one-line POSIX sh command documented there.
 */
interface GitlabJob {
  readonly image?: string;
  readonly entrypoint?: readonly string[];
  readonly variables?: Record<string, string>;
  readonly script?: readonly string[];
  readonly artifacts?: {
    readonly when?: string;
    readonly reports?: { readonly junit?: string };
  };
}

function loadGitlabTemplate(): Record<string, GitlabJob> {
  const text = readFileSync(join(repoRoot, 'templates', 'gitlab', 'wirebench.gitlab-ci.yml'), 'utf8');
  return parse(text) as Record<string, GitlabJob>;
}

const EXPECTED_SCRIPT_LINE =
  'node /app/dist/bin.js run "$WIREBENCH_PROJECT" ${WIREBENCH_ENV:+--env "$WIREBENCH_ENV"} --reporter cli --reporter "junit=$WIREBENCH_JUNIT" $WIREBENCH_ARGS';

describe('templates/gitlab/wirebench.gitlab-ci.yml', () => {
  const template = loadGitlabTemplate();

  it('declares the hidden .wirebench-run job', () => {
    expect(template['.wirebench-run']).toBeDefined();
  });

  const job = template['.wirebench-run'] as GitlabJob;

  it('uses the CLI image pinned by WIREBENCH_VERSION', () => {
    expect(job.image).toBe('ghcr.io/wirebench/wirebench-cli:${WIREBENCH_VERSION}');
  });

  it('overrides the entrypoint', () => {
    expect(job.entrypoint).toEqual(['']);
  });

  it('declares every documented variable with its default', () => {
    const expected: Record<string, string> = {
      WIREBENCH_VERSION: 'latest',
      WIREBENCH_PROJECT: '',
      WIREBENCH_ENV: '',
      WIREBENCH_ARGS: '',
      WIREBENCH_JUNIT: 'wirebench-junit.xml',
    };
    for (const [name, value] of Object.entries(expected)) {
      expect(job.variables?.[name], `variable "${name}"`).toBe(value);
    }
  });

  it('has the exact one-line script from spec §2.4', () => {
    expect(job.script).toEqual([EXPECTED_SCRIPT_LINE]);
  });

  it('always publishes the JUnit report, even on a red pipeline', () => {
    expect(job.artifacts?.when).toBe('always');
    expect(job.artifacts?.reports?.junit).toBe('$WIREBENCH_JUNIT');
  });
});
