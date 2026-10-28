/**
 * Keeps the host portable (host seam, ADR-0033): host code in `@wirebench/host` (`packages/host/src`) reaches
 * Electron only through `HostPlatform`, and keeps its state in the host it belongs to.
 *
 * Three rules, applied to every file under the host (the Electron shell that adapts it stays in the desktop
 * app, under `apps/desktop/src/main`):
 *  - `electron-import`: no import of `electron` or any `electron/*` subpath, in any spelling (`from`,
 *    `import(...)`, a bare `import`, `require(...)`; type imports too: they still tie host code to
 *    Electron's types).
 *  - `outside-package`: no relative import, static or dynamic, JSON included, that resolves outside
 *    `packages/host`. Host code reaches other code only by package name, so an embedding gets everything the
 *    host needs from its declared dependencies (the Electron shell, the desktop manifest and other packages'
 *    sources are all out of reach).
 *  - `module-state`: no top-level `let`/`var`, and no top-level `new Map`/`Set`/`WeakMap`/`WeakSet`/
 *    `AsyncLocalStorage` held in a `const` that is not annotated `ReadonlyMap`/`ReadonlySet`. A second host
 *    in the same process would share such state. The few legitimate cases are in {@link ALLOWED_MODULE_STATE}.
 *
 * And one rule over the rest of the repo (`apps/`, `packages/`, `scripts/`):
 *  - `desktop-export`: only files under `apps/desktop/` import `@wirebench/host/desktop`, the Electron shell's
 *    internals. Every other embedder (the server, the agent) uses the package root alone, `serveCall` included.
 *
 * `node scripts/check-host-boundary.ts` prints one line per violation and exits non-zero if there is any.
 * Wired into `pnpm check` as `pnpm check:host-boundary`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Where the host lives, relative to the repo root. */
const HOST_DIR = 'packages/host/src';

/** The host package, relative to the repo root: no relative import may leave it. */
const PACKAGE_DIR = 'packages/host';

/** Why each rule exists, printed beside a violation. */
export const RULE_REASONS: Readonly<Record<HostBoundaryViolation['rule'], string>> = {
  'electron-import': 'host code reaches Electron only through HostPlatform',
  'outside-package': 'host code reaches outside its package',
  'module-state': 'a second host in the process would share this state',
  'desktop-export': 'only the desktop shell may import @wirebench/host/desktop',
};

export interface HostBoundaryViolation {
  /** Repo-root-relative, forward slashes. */
  file: string;
  line: number;
  rule: 'electron-import' | 'outside-package' | 'module-state' | 'desktop-export';
  text: string;
}

export interface AllowedModuleState {
  /** The file's repo-relative path with forward slashes, e.g. `packages/host/src/serial-session.ts`. */
  file: string;
  /** The top-level binding. */
  name: string;
  reason: string;
}

/** Top-level bindings that may stay, each with why. */
export const ALLOWED_MODULE_STATE: readonly AllowedModuleState[] = [
  {
    file: 'packages/host/src/serial-session.ts',
    name: 'loading',
    reason: 'a module cache of an immutable dynamic import',
  },
  {
    file: 'packages/host/src/script-host.ts',
    name: 'typeCache',
    reason: 'a WeakMap keyed by objects; holds no host data past its keys',
  },
  {
    file: 'packages/host/src/window-scope.ts',
    name: 'caller',
    reason: 'per-call context carrier; holds no host data outside a call',
  },
  {
    file: 'packages/host/src/path-access.ts',
    name: 'pathRoot',
    reason: "per-call context carrier of the calling host's root; holds no host data outside a call",
  },
];

/** The trees `desktop-export` checks, relative to the repo root. */
const EMBEDDER_DIRS: readonly string[] = ['apps', 'packages', 'scripts'];

/** The one tree that may import the desktop subpath. */
const DESKTOP_DIR = 'apps/desktop/';

/** Folders `desktop-export` never descends into: installed, built or hidden. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist', 'out', 'build', 'coverage']);

const DESKTOP_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\(\s*)['"]@wirebench\/host\/desktop(?:\/[^'"]*)?['"]/;

const ELECTRON_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\(\s*)['"]electron(?:\/[^'"]*)?['"]/;
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\(\s*)['"](\.[^'"]*)['"]/g;
const TOP_LEVEL_LET = /^(?:export\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)/;
// The annotation may hold an arrow type (`() => void`), so the initialiser starts at the first `=` that is
// not the `=` of an `=>`.
const TOP_LEVEL_CONST = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*(.+?))?\s*=(?!>)\s*(.*)$/;
const MUTABLE_HOLDER = /^new\s+(?:Map|Set|WeakMap|WeakSet|AsyncLocalStorage)\b/;
const READONLY_ANNOTATION = /^Readonly(?:Map|Set)\b/;

/** The `.ts`/`.tsx` files under `hostDir` (recursively), as paths relative to it. */
function sourceFiles(hostDir: string): string[] {
  return readdirSync(hostDir, { recursive: true, encoding: 'utf8' })
    .map((file) => file.split('\\').join('/'))
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
    .sort();
}

/** The script files under `dir` (repo-relative, forward slashes), skipping {@link SKIPPED_DIRS} and dot folders. */
function scriptFiles(root: string, dir: string): string[] {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name)) found.push(...scriptFiles(root, path));
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      found.push(path);
    }
  }
  return found;
}

/** Every import of `@wirebench/host/desktop` outside {@link DESKTOP_DIR}. */
function desktopExportViolations(root: string): HostBoundaryViolation[] {
  const violations: HostBoundaryViolation[] = [];
  for (const file of EMBEDDER_DIRS.flatMap((dir) => scriptFiles(root, dir)).sort()) {
    if (file.startsWith(DESKTOP_DIR)) continue;
    readFileSync(join(root, file), 'utf8')
      .split('\n')
      .forEach((text, index) => {
        if (!/^\s*(?:\/\/|\*|\/\*)/.test(text) && DESKTOP_IMPORT.test(text)) {
          violations.push({ file, line: index + 1, rule: 'desktop-export', text: text.trim() });
        }
      });
  }
  return violations;
}

/** Whether `name` at the top level of `repoPath` (repo-relative) is in {@link ALLOWED_MODULE_STATE}. */
function isAllowed(repoPath: string, name: string): boolean {
  return ALLOWED_MODULE_STATE.some((entry) => entry.file === repoPath && entry.name === name);
}

export interface HostBoundaryResult {
  violations: HostBoundaryViolation[];
  /** How many host files were checked; a gate that scanned none has checked nothing. */
  scanned: number;
}

/** Whether `specifier` (relative, from `file` under `hostDir`) lands outside the host package. */
function leavesPackage(root: string, hostDir: string, file: string, specifier: string): boolean {
  const target = resolve(hostDir, dirname(file), specifier);
  const packageDir = join(root, PACKAGE_DIR);
  return target !== packageDir && !target.startsWith(packageDir + sep);
}

/**
 * The violations in the host under `root` (the repo root), and how many files were scanned. Throws when the
 * host directory is missing: a wrong root must fail the gate, not pass it.
 */
export function findHostBoundaryViolations(root: string): HostBoundaryResult {
  const hostDir = join(root, HOST_DIR);
  if (!existsSync(hostDir)) {
    throw new Error(`host boundary: no host directory at ${hostDir}`);
  }
  const violations: HostBoundaryViolation[] = [];
  const files = sourceFiles(hostDir);
  for (const file of files) {
    const repoPath = relative(root, join(hostDir, file)).split('\\').join('/');
    const lines = readFileSync(join(hostDir, file), 'utf8').split('\n');
    lines.forEach((text, index) => {
      const line = index + 1;
      const report = (rule: HostBoundaryViolation['rule']): void => {
        violations.push({ file: repoPath, line, rule, text: text.trim() });
      };
      if (!/^\s*(?:\/\/|\*|\/\*)/.test(text)) {
        if (ELECTRON_IMPORT.test(text)) {
          report('electron-import');
          return;
        }
        if ([...text.matchAll(RELATIVE_IMPORT)].some((m) => leavesPackage(root, hostDir, file, m[1]!))) {
          report('outside-package');
          return;
        }
      }
      // Top level means no indentation: the repo's formatter indents everything nested.
      const let_ = TOP_LEVEL_LET.exec(text);
      if (let_ !== null) {
        if (!isAllowed(repoPath, let_[1]!)) report('module-state');
        return;
      }
      const constant = TOP_LEVEL_CONST.exec(text);
      if (constant !== null) {
        const [, name, annotation, initialiser] = constant;
        if (!MUTABLE_HOLDER.test(initialiser!.trim())) return;
        if (annotation !== undefined && READONLY_ANNOTATION.test(annotation.trim())) return;
        if (!isAllowed(repoPath, name!)) report('module-state');
      }
    });
  }
  violations.push(...desktopExportViolations(root));
  return { violations, scanned: files.length };
}

function main(): void {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { violations, scanned } = findHostBoundaryViolations(root);
  if (violations.length === 0) {
    process.stdout.write(
      `host boundary: no electron imports, imports outside the package or module state in host code (${String(scanned)} files scanned), and no import of @wirebench/host/desktop outside the desktop\n`,
    );
    return;
  }
  for (const v of violations) {
    process.stderr.write(`${v.file}:${String(v.line)}: ${v.rule} (${RULE_REASONS[v.rule]}): ${v.text}\n`);
  }
  process.exitCode = 1;
}

// Only run when executed directly, not when the test file imports the function above.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
