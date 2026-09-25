/**
 * The backend contract suite (the desktop's `test/sync/backend-contract.ts`) against two real
 * `ServerBackend`s, which are the desktop's own source (server-sync spec §11, O4). Both share one
 * in-process server with every module over the test database. Each talks through the desktop's
 * `ServerClient`, whose `send` answers through `app.inject`, as its own editor on one team. The
 * suite's assertions are the ones `GitBackend` and `FakeServerBackend` pass in the desktop.
 *
 * The fixture reproduces the git fixture's shared baseline. A writes `environments/qa.yaml`, commits
 * "Initial commit" and pushes. B then starts from `GET /sync/snapshot` at that head, the way *Open a
 * team workspace…* does (§3.4).
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ServerClient } from '../../../../../apps/desktop/src/main/server-client.js';
import type { TokenSource } from '../../../../../apps/desktop/src/main/server-token.js';
import { ServerBackend } from '../../../../../apps/desktop/src/main/sync/server-backend.js';
import {
  SERVER_STATE_DIR,
  ServerState,
  writeTreeFiles,
  type TreeFile,
} from '../../../../../apps/desktop/src/main/sync/server-state.js';
import {
  defineContract,
  ensureWrite,
  readIfExists,
  removeIfExists,
  type Fixture,
} from '../../../../../apps/desktop/test/sync/backend-contract.js';
import { describeDb } from '../../helpers/database.js';
import { describeGit, mkTempDir, removeTempDir } from '../../helpers/git.js';
import { signedInUser, type SignedInUser } from '../../helpers/identity.js';
import { injectSend } from '../../helpers/inject-send.js';
import { seedSyncWorkspace, syncHarness } from '../../helpers/sync.js';
import { seedTeam } from '../../helpers/teams.js';

/** The harness's public URL; `injectSend` routes by path, so only its shape matters. */
const SERVER_URL = 'https://wirebench.test';

/** A signed-in account for `user`, as `AccountService` would answer for the share's URL. */
function accountsFor(user: SignedInUser): TokenSource {
  return {
    tokenFor: () => Promise.resolve(user.token),
    markSignedOut: () => undefined,
  };
}

async function makeServer(): Promise<Fixture> {
  const h = await syncHarness();
  const root = await mkTempDir('wbs-contract-');
  try {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const bob = await signedInUser(h, { email: 'bob@example.com' });
    const team = await seedTeam(h, { name: 'Payments QA', members: [alice, bob] });
    // Both members are editors through the workspace default: neither holds a grant or team admin.
    const workspaceId = await seedSyncWorkspace(h, { team, name: 'Shared', defaultRole: 'editor' });
    const client = new ServerClient({ send: injectSend(h.app) });

    // A shares first: an empty base over an empty server workspace, then the git fixture's commit.
    const treeA = join(root, 'a', 'tree');
    await mkdir(treeA, { recursive: true });
    const a = new ServerBackend({
      client,
      accounts: accountsFor(alice),
      url: SERVER_URL,
      workspaceId,
      tree: treeA,
      state: await ServerState.initialize(join(root, 'a', SERVER_STATE_DIR), null, new Map()),
    });
    await a.setIdentity('Alice', 'alice@example.com');
    await ensureWrite(join(treeA, 'environments', 'qa.yaml'), 'name: QA\n');
    await a.commit('Initial commit');
    await a.push();

    // B joins from the snapshot at the new head, as `joinFromServer` does.
    const snapshot = await client.syncSnapshot(SERVER_URL, bob.token, workspaceId);
    if (snapshot.head === null) {
      throw new Error('the initial push did not reach the server');
    }
    const files = new Map<string, TreeFile>(
      snapshot.files.map((file): [string, TreeFile] => [file.path, { encoding: file.encoding, content: file.content }]),
    );
    const treeB = join(root, 'b', 'tree');
    await mkdir(treeB, { recursive: true });
    await writeTreeFiles(treeB, files);
    const b = new ServerBackend({
      client,
      accounts: accountsFor(bob),
      url: SERVER_URL,
      workspaceId,
      tree: treeB,
      state: await ServerState.initialize(join(root, 'b', SERVER_STATE_DIR), snapshot.head, files),
    });
    await b.setIdentity('Bob', 'bob@example.com');

    return {
      a,
      b,
      writeA: (path, content) => ensureWrite(join(treeA, path), content),
      writeB: (path, content) => ensureWrite(join(treeB, path), content),
      deleteA: (path) => removeIfExists(join(treeA, path)),
      deleteB: (path) => removeIfExists(join(treeB, path)),
      readA: (path) => readIfExists(join(treeA, path)),
      readB: (path) => readIfExists(join(treeB, path)),
      async cleanup() {
        await h.close();
        await removeTempDir(root);
      },
    };
  } catch (error) {
    // `defineContract`'s afterEach only ever sees a fixture that was returned; release this one here.
    await h.close();
    await removeTempDir(root);
    throw error;
  }
}

describeDb('ServerBackend against a real server (server-sync §11, O4)', () => {
  describeGit('backend contract', () => {
    defineContract(makeServer);
  });
});
