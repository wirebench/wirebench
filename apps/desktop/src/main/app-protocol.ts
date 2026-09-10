import { existsSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';

/** A file resolved from the renderer's `out/renderer` directory, ready to be read and served. */
export interface ResolvedRendererFile {
  readonly filePath: string;
  readonly contentType: string;
}

/** `Content-Type` by file extension for everything the built renderer can request. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

/** The default document served for the root path (and any path with no file extension). */
const DEFAULT_DOCUMENT = 'index.html';

function contentTypeFor(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) {
    return undefined;
  }
  return CONTENT_TYPES[filePath.slice(dot)];
}

/**
 * Resolves an `app://wirebench/<urlPath>` request to a file under `rootDir` (the renderer's
 * `out/renderer` directory), pure and side-effect-free apart from the filesystem checks needed
 * to reject a missing file or directory. Returns `undefined` for anything outside `rootDir`
 * (path traversal, absolute paths that escape it) or that does not resolve to a regular file.
 */
export function resolveRendererFile(rootDir: string, urlPath: string): ResolvedRendererFile | undefined {
  const decoded = safeDecode(urlPath);
  if (decoded === undefined) {
    return undefined;
  }

  const trimmed = decoded.replace(/^\/+/, '');
  const relativePath = trimmed.length === 0 ? DEFAULT_DOCUMENT : trimmed;

  const normalizedRoot = normalize(rootDir);
  const candidate = normalize(join(normalizedRoot, relativePath));

  // The normalized candidate must stay inside the normalized root — this is what rejects
  // `..` traversal (including an already-collapsed `../secret.txt`) regardless of how many
  // segments or slashes the request used to get there.
  if (candidate !== normalizedRoot && !candidate.startsWith(normalizedRoot + sep)) {
    return undefined;
  }

  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    return undefined;
  }

  const contentType = contentTypeFor(candidate);
  if (contentType === undefined) {
    return undefined;
  }

  return { filePath: candidate, contentType };
}

function safeDecode(urlPath: string): string | undefined {
  try {
    return decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
}
