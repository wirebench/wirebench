/**
 * Completing a field name in the gRPC Message tab, against the schema the request was imported from.
 *
 * Monaco's suggest overlay does not reliably render in this headless Electron window — the same
 * limitation `editor.spec.ts` records for the XML completion — so the spec asks for the widget and
 * falls back to the channel the widget itself calls. Either way what is asserted is the same: the
 * fields of the message the cursor is in, and nothing for a path the schema does not have.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { importProto, openGrpcRequest, placeGreeterProtos, setMessage } from '../helpers/grpc.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, workspaceProjectDir } from '../helpers/project.js';
import { startTestGrpcServer, type TestGrpcServer } from '../helpers/test-server.js';

/** The slice of the preload API the fallback assertion reaches for. */
interface FallbackWirebenchApi {
  readonly workspace: {
    snapshot(request: undefined): Promise<
      | {
          readonly ok: true;
          readonly value: { readonly workspace: { readonly projects: readonly { readonly id: string }[] } | null };
        }
      | { readonly ok: false }
    >;
  };
  readonly project: {
    snapshot(request: { readonly projectId: string }): Promise<
      | {
          readonly ok: true;
          readonly value: { readonly project: { readonly grpcApis: readonly { readonly id: string }[] } | null };
        }
      | { readonly ok: false }
    >;
  };
  readonly api: {
    grpcFields(request: {
      readonly apiId: string;
      readonly type: string;
      readonly path: readonly string[];
    }): Promise<
      | { readonly ok: true; readonly value: { readonly fields: readonly { readonly name: string }[] } }
      | { readonly ok: false }
    >;
  };
}

test.describe('gRPC: complete a field name from the message descriptor', () => {
  let launched: LaunchedApp | undefined;
  let server: TestGrpcServer | undefined;
  let userDataDir: string | undefined;

  test.beforeEach(async () => {
    server = await startTestGrpcServer();
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-grpc-complete-'));
    launched = await launchApp({ userDataDir });
  });

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    await server?.close();
    server = undefined;
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      userDataDir = undefined;
    }
  });

  test('offers the request type’s fields, and the nested message’s inside it', async () => {
    const page = launched!.window;
    await createWorkspace(page, 'gRPC');
    await createProject(page, 'Completion');
    const protoPath = placeGreeterProtos(workspaceProjectDir(userDataDir!, 'Completion'));
    await importProto(page, protoPath, 'Greeter', server!.target);

    await openGrpcRequest(page, 'SayHello');
    await setMessage(page, '{\n  \n}');

    // Put the caret on the blank line inside the object and start a key.
    const editor = page.locator('[aria-label="Request message"]');
    await editor.focus();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.type('"');

    const suggestWidget = page.locator('.suggest-widget');
    const appeared = await suggestWidget
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (appeared) {
      await expect(suggestWidget).toContainText('big_number');
    } else {
      // The overlay needs a compositor and focus stack this headless window does not fully give,
      // so assert the same answer through `api.grpcFields` — the channel the provider itself calls.
      const names = await page.evaluate(async (): Promise<Record<string, string[]> | undefined> => {
        const wirebench = (globalThis as unknown as { wirebench: FallbackWirebenchApi }).wirebench;
        const workspace = await wirebench.workspace.snapshot(undefined);
        const projectId = workspace.ok ? workspace.value.workspace?.projects[0]?.id : undefined;
        if (projectId === undefined) {
          return undefined;
        }
        const snapshot = await wirebench.project.snapshot({ projectId });
        const apiId = snapshot.ok ? snapshot.value.project?.grpcApis[0]?.id : undefined;
        if (apiId === undefined) {
          return undefined;
        }
        const type = 'wirebench.greet.HelloRequest';
        const ask = async (path: readonly string[]): Promise<string[]> => {
          const result = await wirebench.api.grpcFields({ apiId, type, path });
          return result.ok ? result.value.fields.map((field) => field.name) : [];
        };
        return { root: await ask([]), address: await ask(['address']), nope: await ask(['name']) };
      });

      expect(names?.root).toContain('big_number');
      // A nested message offers its own fields, not the root's.
      expect(names?.address).toEqual(['city', 'country']);
      // A scalar has none: the path stops there.
      expect(names?.nope).toEqual([]);
    }
  });
});
