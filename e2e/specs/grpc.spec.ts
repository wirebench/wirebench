import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  grpcApiRow,
  grpcStatus,
  importProto,
  openGrpcRequest,
  openGrpcResponseTab,
  placeGreeterProtos,
  sendGrpc,
  setMessage,
} from '../helpers/grpc.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, saveAll, workspaceProjectDir } from '../helpers/project.js';
import { startTestGrpcServer, type TestGrpcServer } from '../helpers/test-server.js';

test.describe('gRPC: import a .proto set, call a method, read the response', () => {
  let launched: LaunchedApp | undefined;
  let server: TestGrpcServer | undefined;
  let userDataDir: string | undefined;

  test.beforeEach(async () => {
    server = await startTestGrpcServer();
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-grpc-'));
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

  test('imports the greeter, makes a folder per service and a request per method, and calls one', async () => {
    const page = launched!.window;
    await createWorkspace(page, 'gRPC');
    await createProject(page, 'Greet');
    const protoPath = placeGreeterProtos(workspaceProjectDir(userDataDir!, 'Greet'));

    await importProto(page, protoPath, 'Greeter', server!.target);
    await expect(grpcApiRow(page, 'Greeter')).toContainText('gRPC');

    await openGrpcRequest(page, 'SayHello');
    // The import seeded every request with a sample of its input type; the method picker names it.
    await expect(page.getByTestId('grpc-method')).toHaveValue('wirebench.greet.Greeter/SayHello');
    await expect(page.getByTestId('grpc-target')).toContainText(server!.target);

    await setMessage(page, '{"name":"Ada","tags":["x"]}');
    await sendGrpc(page);

    // The test server echoes what it decoded, so the reply proves the message was encoded from the
    // definition rather than merely shown in the editor.
    await expect(grpcStatus(page)).toContainText('OK (0)');
    const messages = page.getByTestId('grpc-response-messages');
    await expect(messages).toContainText('Hello, Ada');
    await expect(messages).toContainText('"tags"');

    await openGrpcResponseTab(page, 'Metadata');
    await expect(page.getByTestId('grpc-response-metadata')).toContainText('grpc-status');
    await openGrpcResponseTab(page, 'Timing');
    await expect(page.getByTestId('grpc-response-timing')).toBeVisible();
    await openGrpcResponseTab(page, 'Raw');
    await expect(page.getByTestId('grpc-response-raw')).toContainText('/wirebench.greet.Greeter/SayHello');

    // The console's HTTP Log is one list across all three protocols.
    const logRow = page.locator('[data-testid="http-log-row"]');
    await expect(logRow).toHaveCount(1);
    await expect(logRow.first()).toContainText('SayHello');
  });

  test('lists every message a server stream returns, and shows a non-OK status as a result', async () => {
    const page = launched!.window;
    await createWorkspace(page, 'gRPC');
    await createProject(page, 'Greet');
    await importProto(page, placeGreeterProtos(workspaceProjectDir(userDataDir!, 'Greet')), 'Greeter', server!.target);

    await openGrpcRequest(page, 'LotsOfReplies');
    await setMessage(page, '{"count":3}');
    await sendGrpc(page);
    await expect(grpcStatus(page)).toContainText('3 messages');
    await expect(page.getByTestId('grpc-response-message')).toHaveCount(3);

    await openGrpcRequest(page, 'Fail');
    await setMessage(page, '{"code":5,"message":"no such greeting"}');
    await sendGrpc(page);
    await expect(grpcStatus(page)).toContainText('NOT_FOUND (5)');
    await expect(grpcStatus(page)).toContainText('no such greeting');
  });

  test('writes the API as kind: grpc beside the REST ones, with the .proto set cached under it', async () => {
    const page = launched!.window;
    await createWorkspace(page, 'gRPC');
    await createProject(page, 'Greet');
    const projectDir = workspaceProjectDir(userDataDir!, 'Greet');
    await importProto(page, placeGreeterProtos(projectDir), 'Greeter', server!.target);
    await saveAll(page);

    const apisDir = join(projectDir, 'apis');
    const apiDir = readdirSync(apisDir)
      .map((name) => join(apisDir, name))
      .find((dir) => existsSync(join(dir, 'api.yaml')));
    expect(apiDir).toBeDefined();
    const apiYaml = readFileSync(join(apiDir!, 'api.yaml'), 'utf8');
    expect(apiYaml).toContain('kind: grpc');
    expect(apiYaml).toContain(`target: ${server!.target}`);
    expect(existsSync(join(apiDir!, 'definition', 'protos', 'greeter.proto'))).toBe(true);
    expect(existsSync(join(apiDir!, 'definition', 'protos', 'wirebench', 'common', 'address.proto'))).toBe(true);
    expect(existsSync(join(apiDir!, 'definition', 'manifest.yaml'))).toBe(true);
  });
});
