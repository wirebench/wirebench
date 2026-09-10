import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAppProtocol } from '../src/main/app-protocol-handler.js';

// Mock the app-protocol module
let tempDir: string;

vi.mock('../src/main/app-protocol.js', () => ({
  resolveRendererFile: (_root: unknown, pathname: string) => {
    if (!tempDir) return undefined;
    if (pathname === '/' || pathname === '') {
      return { filePath: join(tempDir, 'index.html'), contentType: 'text/html' };
    }
    if (pathname === '/app.js') {
      return { filePath: join(tempDir, 'app.js'), contentType: 'text/javascript' };
    }
    return undefined;
  },
}));

describe('handleAppProtocol', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wirebench-handler-test-'));
    writeFileSync(join(tempDir, 'index.html'), '<html></html>');
    writeFileSync(join(tempDir, 'app.js'), 'console.log(1)');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('allows GET requests', async () => {
    const request = { url: 'app://wirebench/', method: 'GET' };
    const response = await handleAppProtocol(request, tempDir);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html');
    const body = await response.text();
    expect(body).toBe('<html></html>');
  });

  it('allows HEAD requests and returns no body', async () => {
    const request = { url: 'app://wirebench/', method: 'HEAD' };
    const response = await handleAppProtocol(request, tempDir);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html');
    const body = await response.text();
    expect(body).toBe('');
  });

  it('rejects POST with 405 Method Not Allowed', async () => {
    const request = { url: 'app://wirebench/', method: 'POST' };
    const response = await handleAppProtocol(request, tempDir);

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    const body = await response.text();
    expect(body).toBe('Method Not Allowed');
  });

  it('rejects PUT with 405 Method Not Allowed', async () => {
    const request = { url: 'app://wirebench/', method: 'PUT' };
    const response = await handleAppProtocol(request, tempDir);

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('rejects DELETE with 405 Method Not Allowed', async () => {
    const request = { url: 'app://wirebench/', method: 'DELETE' };
    const response = await handleAppProtocol(request, tempDir);

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('rejects PATCH with 405 Method Not Allowed', async () => {
    const request = { url: 'app://wirebench/', method: 'PATCH' };
    const response = await handleAppProtocol(request, tempDir);

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('returns 404 for missing files on GET', async () => {
    const request = { url: 'app://wirebench/missing.js', method: 'GET' };
    const response = await handleAppProtocol(request, tempDir);

    expect(response.status).toBe(404);
  });

  it('returns 404 for missing files on HEAD', async () => {
    const request = { url: 'app://wirebench/missing.js', method: 'HEAD' };
    const response = await handleAppProtocol(request, tempDir);

    expect(response.status).toBe(404);
  });

  it('returns 405 for missing files on POST (method check comes first)', async () => {
    const request = { url: 'app://wirebench/missing.js', method: 'POST' };
    const response = await handleAppProtocol(request, tempDir);

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });
});
