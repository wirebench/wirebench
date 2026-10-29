/**
 * Seeds the browser suite's server through its own admin CLI and HTTP API, the way an operator and the
 * desktop's *Share to a team* would. The browser opens existing server workspaces only (#786 covers
 * creating one), so the workspace, its project and its requests are all here before the spec starts:
 *
 * 1. `admin invite`, run in the server service with `docker compose exec`, invites a server admin.
 * 2. `POST /invitations/accept` sets that user's local password; the answer carries a device token.
 * 3. `POST /teams` makes a team; its creator is its first admin.
 * 4. `POST /teams/:id/workspaces` makes a server workspace in it. The creator, a member, gets the
 *    workspace's admin grant (teams spec §3.2), which is the access the spec needs.
 * 5. `POST /workspaces/:id/sync/commits` pushes one commit holding the workspace manifest and one
 *    project, written by the engine's own `saveWorkspace`/`saveProject` into a scratch folder, so the
 *    bytes are what the app itself writes. The manifest's id is the server workspace's, which is what
 *    a join checks.
 *
 * Every name carries a run stamp, so a rerun against a stack that is still up seeds afresh beside the
 * last run's rows instead of colliding with them.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import {
  createApi,
  createProject,
  createRestRequest,
  createWorkspace,
  saveProject,
  saveWorkspace,
  workspaceProjectDir,
} from '@wirebench/engine';
import { BASE_URL, COMPOSE_FILE, ECHO_URL, SERVER_SERVICE, type Seed } from './stack.js';

const API = `${BASE_URL}/api/v1`;

/** One API call; throws with the problem body on anything but `expected`. */
async function call<T>(method: string, path: string, body: unknown, token?: string, expected = 201): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status !== expected) {
    throw new Error(`${method} ${path} answered ${String(response.status)}: ${text}`);
  }
  return JSON.parse(text) as T;
}

/** Step 1: `wirebench-server admin invite`, and the secret at the end of the link it prints. */
function invite(email: string): string {
  // The compose file names the project after WIREBENCH_E2E_PORT, so this reaches this run's stack.
  const out = execFileSync(
    'docker',
    ['compose', '-f', COMPOSE_FILE, 'exec', '-T', SERVER_SERVICE, 'node', '/app/dist/bin.js', 'admin', 'invite', email],
    { encoding: 'utf8' },
  );
  const link = /\/invite\/([^\s/]+)\s*$/m.exec(out);
  if (link?.[1] === undefined) throw new Error(`admin invite printed no link:\n${out}`);
  return link[1];
}

/** Every file under `dir` as one push change, `/`-separated, as the tree holds it. */
async function treeChanges(dir: string): Promise<{ path: string; encoding: 'utf8'; content: string }[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  return await Promise.all(
    files.sort().map(async (file) => ({
      path: relative(dir, file).split(sep).join('/'),
      encoding: 'utf8' as const,
      content: await readFile(file, 'utf8'),
    })),
  );
}

/** Seeds one user, team and server workspace holding one REST project, and says what it made. */
export async function seedServer(): Promise<Seed> {
  const stamp = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const seed: Seed = {
    email: `browser-e2e-${stamp}@example.com`,
    // A test value made here and handed to the spec through the environment; it never leaves this run.
    password: randomBytes(18).toString('base64url'),
    teamName: `Browser team ${stamp}`,
    workspaceName: `Browser workspace ${stamp}`,
    projectName: 'Echo project',
    apiName: 'Echo API',
    echoRequest: 'Echo hello',
    loopbackRequest: 'Loopback',
  };

  const secret = invite(seed.email);
  const { token } = await call<{ token: string }>('POST', '/invitations/accept', {
    secret,
    displayName: 'Browser E2E',
    password: seed.password,
    device: { name: 'browser e2e seed' },
  });
  const team = await call<{ id: string }>('POST', '/teams', { name: seed.teamName }, token);
  const workspace = await call<{ id: string }>(
    'POST',
    `/teams/${team.id}/workspaces`,
    { name: seed.workspaceName },
    token,
  );

  const scratch = await mkdtemp(join(tmpdir(), 'wirebench-browser-seed-'));
  try {
    const project = createProject(seed.projectName);
    const api = createApi(seed.apiName, {
      requests: [
        createRestRequest(seed.echoRequest, { url: `${ECHO_URL}/hello`, order: 0 }),
        createRestRequest(seed.loopbackRequest, { url: 'http://127.0.0.1:9/', order: 1 }),
      ],
    });
    const slug = 'echo-project';
    const projectDir = workspaceProjectDir(scratch, slug);
    await mkdir(projectDir, { recursive: true });
    await saveProject({ ...project, containers: { ...project.containers, rest: [api] } }, projectDir);
    const manifest = createWorkspace(seed.workspaceName, { id: workspace.id });
    await saveWorkspace({ ...manifest, projects: [{ id: project.id, slug, source: 'internal' }] }, scratch);

    await call(
      'POST',
      `/workspaces/${workspace.id}/sync/commits`,
      {
        parent: null,
        commits: [
          {
            subject: 'Seed the browser e2e workspace',
            at: new Date().toISOString(),
            changes: await treeChanges(scratch),
          },
        ],
      },
      token,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return seed;
}
