import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRendererFile } from '../src/main/app-protocol.js';

describe('resolveRendererFile', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wirebench-app-protocol-'));
    writeFileSync(join(root, 'index.html'), '<html></html>');
    writeFileSync(join(root, 'app.js'), 'console.log(1)');
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'assets', 'style.css'), 'body{}');
    writeFileSync(join(root, 'font.woff2'), '');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('serves index.html for the root path', () => {
    const result = resolveRendererFile(root, '/');
    expect(result).toEqual({ filePath: join(root, 'index.html'), contentType: 'text/html' });
  });

  it('serves index.html when the path is empty', () => {
    const result = resolveRendererFile(root, '');
    expect(result?.filePath).toBe(join(root, 'index.html'));
  });

  it('resolves a nested file and its content type', () => {
    const result = resolveRendererFile(root, '/assets/style.css');
    expect(result).toEqual({ filePath: join(root, 'assets', 'style.css'), contentType: 'text/css' });
  });

  it.each([
    ['app.js', 'text/javascript'],
    ['font.woff2', 'font/woff2'],
  ])('maps %s to content type %s', (file, contentType) => {
    const result = resolveRendererFile(root, `/${file}`);
    expect(result?.contentType).toBe(contentType);
  });

  it('rejects path traversal', () => {
    expect(resolveRendererFile(root, '/../secret.txt')).toBeUndefined();
    expect(resolveRendererFile(root, '/assets/../../secret.txt')).toBeUndefined();
    expect(resolveRendererFile(root, '/..%2f..%2fsecret.txt')).toBeUndefined();
  });

  it('returns undefined for a file that does not exist', () => {
    expect(resolveRendererFile(root, '/missing.js')).toBeUndefined();
  });

  it('returns undefined for a directory', () => {
    expect(resolveRendererFile(root, '/assets')).toBeUndefined();
  });
});
