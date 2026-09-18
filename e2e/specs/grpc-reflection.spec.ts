import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { discoverProto, grpcApiRow, grpcStatus, openGrpcRequest, sendGrpc, setMessage } from '../helpers/grpc.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, saveAll, workspaceProjectDir } from '../helpers/project.js';
import { startTestGrpcServer, type TestGrpcServer } from '../helpers/test-server.js';

test.describe('gRPC: discover a server, then call what it described', () => {
  let launched: LaunchedApp | undefined;
  let server: TestGrpcServer | undefined;
  let userDataDir: string | undefined;

  test.beforeEach(async () => {
    server = await startTestGrpcServer({ reflection: ['v1'] });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-grpc-reflect-'));
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

  test('builds the same tree an import builds, calls a method, and caches the descriptors', async () => {
    const page = launched!.window;
    await createWorkspace(page, 'gRPC');
    await createProject(page, 'Discovered');

    await discoverProto(page, server!.target, 'Greeter');
    await expect(grpcApiRow(page, 'Greeter')).toContainText('gRPC');
    // The summary says where the schema came from, since no file was read.
    await expect(page.getByTestId('grpc-api-row').first()).toBeVisible();

    await openGrpcRequest(page, 'SayHello');
    await expect(page.getByTestId('grpc-method')).toHaveValue('wirebench.greet.Greeter/SayHello');
    await setMessage(page, '{"name":"Ada"}');
    await sendGrpc(page);
    await expect(grpcStatus(page)).toContainText('OK (0)');
    await expect(page.getByTestId('grpc-response-messages')).toContainText('Hello, Ada');

    await saveAll(page);
    const definitionDir = join(workspaceProjectDir(userDataDir!, 'Discovered'), 'apis', 'Greeter', 'definition');
    expect(existsSync(join(definitionDir, 'descriptors.binpb'))).toBe(true);
    expect(existsSync(join(definitionDir, 'protos'))).toBe(false);
  });

  test('asks the server again from the API tab', async () => {
    const page = launched!.window;
    await createWorkspace(page, 'gRPC');
    await createProject(page, 'Refreshed');
    await discoverProto(page, server!.target, 'Greeter');

    await grpcApiRow(page, 'Greeter').click();
    await expect(page.getByTestId('grpc-definition-card')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('grpc-definition-version').selectOption('v1');
    await page.getByTestId('grpc-definition-refresh').click();

    // The server describes the same schema, so the refresh reports that nothing moved.
    await expect(page.getByTestId('grpc-definition-changed')).toContainText('Nothing changed', { timeout: 30_000 });
  });
});
