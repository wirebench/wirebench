/**
 * Recipe smoke script: proves that a built CLI — whatever ships it — actually runs a project
 * against a live service and behaves the way the integration suite already pins down. CI drives
 * this three ways (`--via node|npm|docker`) once each recipe exists (Tasks 3, 4); today only
 * `--via node` can run locally (the others need a built image or aren't published yet), but all
 * three share one set of checks so a defect in the container or the tarball surfaces here instead
 * of only in a downstream user's build.
 *
 * The four checks, run against the fixture used by `packages/cli/test/integration/*.test.ts`
 * (`demo/ok`, `demo/broken`, `demo/secure`) so nothing new is added to it:
 *   1. a passing selection exits 0;
 *   2. a failing selection exits 1;
 *   3. `--reporter junit=<file>` leaves a parseable file on the host with the selection's
 *      testcase count;
 *   4. a run authenticating through `WIREBENCH_SECRET_DEMO_PASSWORD` never shows the secret value
 *      in stdout, stderr or the JUnit file — the same property `secrets.test.ts` checks for the
 *      Node-run CLI, checked again for whichever recipe is under test.
 *
 * On the first failed expectation, this prints one line naming it and exits 1. A usage mistake
 * (bad or missing flags) exits 2, matching the CLI's own convention.
 *
 * `--via docker` and `--gitlab` need care because they aren't exercised by `cli-smoke.test.ts`
 * (no `docker` guarantee in every environment this repo is checked out in) — they're covered by
 * `image-smoke` in CI once Tasks 3 and 5 land. `--gitlab`'s template doesn't exist until Task 5;
 * until then it exits 2 with a clear message rather than failing in a confusing way.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { FIXTURE, startDemoServer } from '../packages/cli/test/integration/helpers.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const NODE_BIN = join(repoRoot, 'packages', 'cli', 'dist', 'bin.js');
const SECRET = 'hunter2-long';

interface RunOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a recipe's CLI with the given `wirebench` args and environment, capturing output. */
type Runner = (args: readonly string[], env: Readonly<Record<string, string>>) => Promise<RunOutcome>;

/** Prints a one-line reason and exits 1, for a failed expectation. */
function fail(reason: string): never {
  process.stderr.write(`${reason}\n`);
  process.exit(1);
}

/** Prints a one-line reason and exits 2, for a usage mistake — matching the CLI's own code. */
function usageError(reason: string): never {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function assertExit(outcome: RunOutcome, expected: number, label: string): void {
  if (outcome.code !== expected) {
    fail(
      `${label}: expected exit ${expected}, got ${outcome.code}\n` +
        `--- stdout ---\n${outcome.stdout}\n--- stderr ---\n${outcome.stderr}`,
    );
  }
}

function execCapture(cmd: string, args: readonly string[], env: Readonly<Record<string, string>>): Promise<RunOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) => resolvePromise({ code: -1, stdout, stderr: `${stderr}${String(error)}` }));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Runs the four checks against `run`, a recipe-specific runner. `projectArg` is how the recipe
 * names the fixture project (an absolute host path for `node`/`npm`, `.` for `docker` where the
 * fixture is mounted at the container's working directory). `junitDir` is a host-writable
 * directory the JUnit files land in; `toRunnerPath` turns a host path under it into whatever
 * string the recipe's CLI invocation should be given for `--reporter junit=<…>`.
 */
async function runChecks(
  run: Runner,
  projectArg: string,
  junitDir: string,
  toRunnerPath: (hostPath: string) => string,
  demoUrl: string,
): Promise<void> {
  const varArgs = ['--var', `baseUrl=${demoUrl}`];

  assertExit(
    await run(['run', projectArg, '-e', 'local', ...varArgs, 'demo/ok'], {}),
    0,
    'passing selection (demo/ok)',
  );
  assertExit(
    await run(['run', projectArg, '-e', 'local', ...varArgs, 'demo/broken'], {}),
    1,
    'failing selection (demo/broken)',
  );

  const junitHost = join(junitDir, 'smoke.xml');
  const junitOutcome = await run(
    [
      'run',
      projectArg,
      '-e',
      'local',
      ...varArgs,
      '--reporter',
      'cli',
      '--reporter',
      `junit=${toRunnerPath(junitHost)}`,
      'demo/ok',
      'demo/broken',
    ],
    {},
  );
  assertExit(junitOutcome, 1, 'junit selection (demo/ok, demo/broken)');
  const junitXml = await readJunit(junitHost);
  if (!junitXml.trimStart().startsWith('<?xml')) {
    fail(`junit reporter: ${junitHost} is not parseable XML:\n${junitXml.slice(0, 200)}`);
  }
  const testcases = junitXml.match(/<testcase[\s/>]/g)?.length ?? 0;
  if (testcases !== 2) {
    fail(`junit reporter: expected 2 testcases in ${junitHost}, found ${testcases}`);
  }

  const secretHost = join(junitDir, 'secret.xml');
  const secretOutcome = await run(
    [
      'run',
      projectArg,
      '-e',
      'local',
      ...varArgs,
      '--reporter',
      'cli',
      '--reporter',
      `junit=${toRunnerPath(secretHost)}`,
      'demo/secure',
    ],
    { WIREBENCH_SECRET_DEMO_PASSWORD: SECRET },
  );
  assertExit(secretOutcome, 0, 'secret selection (demo/secure)');
  const secretXml = await readJunit(secretHost);
  const secretBasic = Buffer.from(`svc:${SECRET}`).toString('base64');
  const outputs: readonly (readonly [string, string])[] = [
    ['stdout', secretOutcome.stdout],
    ['stderr', secretOutcome.stderr],
    ['junit file', secretXml],
  ];
  for (const [label, text] of outputs) {
    if (text.includes(SECRET) || text.includes(secretBasic)) {
      fail(`secret leaked into ${label}`);
    }
  }
}

async function readJunit(hostPath: string): Promise<string> {
  try {
    return await readFile(hostPath, 'utf8');
  } catch {
    fail(`junit reporter did not write ${hostPath}`);
  }
}

/** Builds `packages/engine` and `packages/cli`, the way `global-setup.ts` does for the suite. */
function buildDist(): void {
  const tsc = createRequire(join(repoRoot, 'package.json')).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-b', join('packages', 'engine'), join('packages', 'cli')], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

async function smokeNode(demoUrl: string): Promise<void> {
  buildDist();
  if (!existsSync(NODE_BIN)) {
    fail(`--via node: build did not produce ${NODE_BIN}`);
  }
  const junitDir = await mkdtemp(join(tmpdir(), 'wirebench-cli-smoke-node-'));
  try {
    const run: Runner = (args, env) => execCapture(process.execPath, [NODE_BIN, ...args], { NO_COLOR: '1', ...env });
    await runChecks(run, FIXTURE, junitDir, (hostPath) => hostPath, demoUrl);
  } finally {
    await rm(junitDir, { recursive: true, force: true });
  }
}

async function smokeNpm(demoUrl: string): Promise<void> {
  const { packPackages } = await import('./pack-check.ts');
  const outDir = await mkdtemp(join(tmpdir(), 'wirebench-cli-smoke-pack-'));
  const installDir = await mkdtemp(join(tmpdir(), 'wirebench-cli-smoke-install-'));
  const junitDir = await mkdtemp(join(tmpdir(), 'wirebench-cli-smoke-junit-'));
  try {
    const tarballs = await packPackages(outDir);
    execFileSync('npm', ['install', '--no-audit', '--no-fund', tarballs.engine, tarballs.cli], {
      cwd: installDir,
      shell: process.platform === 'win32',
      stdio: 'pipe',
    });
    const bin = join(installDir, 'node_modules', '@wirebench', 'cli', 'dist', 'bin.js');
    if (!existsSync(bin)) {
      fail(`--via npm: install did not produce ${bin}`);
    }
    const run: Runner = (args, env) => execCapture(process.execPath, [bin, ...args], { NO_COLOR: '1', ...env });
    await runChecks(run, FIXTURE, junitDir, (hostPath) => hostPath, demoUrl);
  } finally {
    await Promise.all([outDir, installDir, junitDir].map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

/**
 * Copies the fixture into a temp dir and runs it as `docker run --rm --network host -v
 * <tmp>:/work -e … <image>`: `--network host` (Linux CI only) makes the demo server started on
 * the runner reachable from inside the container at the same `127.0.0.1:<port>` URL, and the
 * project path the CLI is given is `.`, relative to `/work` where the fixture copy is mounted.
 */
async function smokeDocker(demoUrl: string, image: string): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'wirebench-cli-smoke-docker-'));
  try {
    await cp(FIXTURE, workDir, { recursive: true });
    const run: Runner = (args, env) => {
      const envFlags = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
      return execCapture(
        'docker',
        ['run', '--rm', '--network', 'host', '-v', `${workDir}:/work`, ...envFlags, image, ...args],
        {},
      );
    };
    await runChecks(run, '.', workDir, (hostPath) => relative(workDir, hostPath), demoUrl);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** `--gitlab`: runs the GitLab template's `script[0]` in the image instead of the CLI directly. */
function checkGitlabTemplate(): void {
  const templatePath = join(repoRoot, 'templates', 'gitlab', 'wirebench.gitlab-ci.yml');
  if (!existsSync(templatePath)) {
    usageError(
      `--gitlab: ${templatePath} does not exist yet (Task 5 adds the GitLab template); nothing to smoke-test.`,
    );
  }
  // Task 5 replaces this with: parse the template's `.wirebench-run.script[0]`, run it with
  // `docker run --entrypoint sh … <image> -c "<script>"`, passing WIREBENCH_* via `-e`, then the
  // same four checks as the other recipes.
  fail('--gitlab: the template exists but running its script is not implemented yet (Task 5).');
}

/** `--serve-only`: starts the demo server and stays up until killed, for another CI step to hit. */
async function serveOnly(): Promise<void> {
  const demo = await startDemoServer();
  const line = `url=${demo.url}\n`;
  const githubOutput = process.env['GITHUB_OUTPUT'];
  if (githubOutput !== undefined && githubOutput.length > 0) {
    await appendFile(githubOutput, line);
  } else {
    process.stdout.write(line);
  }
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void demo.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise<void>(() => {
    // Stays alive until a signal handler above calls `process.exit`.
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      via: { type: 'string' },
      image: { type: 'string' },
      gitlab: { type: 'boolean' },
      'serve-only': { type: 'boolean' },
    },
  });

  if (values['serve-only'] === true) {
    await serveOnly();
    return;
  }

  const via = values.via;
  if (via !== 'node' && via !== 'npm' && via !== 'docker') {
    usageError(`--via must be one of node, npm, docker (got ${via ?? 'nothing'})`);
  }

  if (values.gitlab === true) {
    if (via !== 'docker') {
      usageError('--gitlab requires --via docker');
    }
    checkGitlabTemplate();
    return;
  }

  if (via === 'docker' && (values.image === undefined || values.image.length === 0)) {
    usageError('--via docker requires --image <ref>');
  }

  const demo = await startDemoServer();
  try {
    if (via === 'node') {
      await smokeNode(demo.url);
    } else if (via === 'npm') {
      await smokeNpm(demo.url);
    } else {
      await smokeDocker(demo.url, values.image as string);
    }
  } finally {
    await demo.close();
  }
  process.stdout.write(`cli-smoke --via ${via}: ok\n`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await main();
}
