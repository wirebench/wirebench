import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { grpcStatus, importProto, openGrpcRequest, placeGreeterProtos, setMessage } from '../helpers/grpc.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, workspaceProjectDir } from '../helpers/project.js';
import { startTestGrpcServer, type TestGrpcServer } from '../helpers/test-server.js';

test.describe('gRPC: watch a stream fill in, and talk into an open call', () => {
  let launched: LaunchedApp | undefined;
  let server: TestGrpcServer | undefined;
  let userDataDir: string | undefined;

  test.beforeEach(async () => {
    server = await startTestGrpcServer();
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-grpc-stream-'));
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

  test('shows a server stream message by message, before the call ends', async () => {
    const page = launched!.window;
    await createWorkspace(page, 'gRPC');
    await createProject(page, 'Streams');
    const protoPath = placeGreeterProtos(workspaceProjectDir(userDataDir!, 'Streams'));
    await importProto(page, protoPath, 'Greeter', server!.target);

    await openGrpcRequest(page, 'LotsOfReplies');
    // Slow enough that the pane is watched filling in rather than caught after the fact.
    await setMessage(page, '{"count": 5, "delay_ms": 400}');
    await page.getByTestId('grpc-send').click();

    // The tab strip and the first messages are up while the call is still running.
    await expect(page.getByTestId('grpc-response-status')).toContainText('Streaming…', { timeout: 20_000 });
    await expect(page.getByTestId('grpc-response-message').first()).toBeVisible();
    const partial = await page.getByTestId('grpc-response-message').count();
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(5);

    await expect(grpcStatus(page)).toContainText('OK (0)', { timeout: 20_000 });
    await expect(page.getByTestId('grpc-response-message')).toHaveCount(5);
  });

  test('pushes a second message into an open bidirectional call', async () => {
    const page = launched!.window;
    await createWorkspace(page, 'gRPC');
    await createProject(page, 'Chat');
    const protoPath = placeGreeterProtos(workspaceProjectDir(userDataDir!, 'Chat'));
    await importProto(page, protoPath, 'Greeter', server!.target);

    await openGrpcRequest(page, 'Chat');
    // Nothing is sent up front: every message on this call is typed into the composer.
    await setMessage(page, '[]');
    await page.getByTestId('grpc-open-stream').click();

    const composer = page.getByTestId('grpc-stream-composer');
    await expect(composer).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('grpc-stream-message').fill('{"name":"Ada"}');
    await page.getByTestId('grpc-stream-send').click();
    await expect(page.getByTestId('grpc-response-messages')).toContainText('Hello, Ada', { timeout: 20_000 });

    // The call is still open, so a second message goes into the same conversation.
    await page.getByTestId('grpc-stream-message').fill('{"name":"Grace"}');
    await page.getByTestId('grpc-stream-send').click();
    await expect(page.getByTestId('grpc-response-messages')).toContainText('Hello, Grace', { timeout: 20_000 });
    await expect(page.getByTestId('grpc-response-message')).toHaveCount(2);

    await page.getByTestId('grpc-half-close').click();
    await expect(grpcStatus(page)).toContainText('OK (0)', { timeout: 20_000 });
    await expect(page.getByTestId('grpc-response-message')).toHaveCount(2);
  });
});
