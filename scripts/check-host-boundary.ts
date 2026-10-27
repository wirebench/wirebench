/**
 * Keeps the desktop host portable (host seam, ADR-0033): host code under `apps/desktop/src/main` reaches
 * Electron only through `HostPlatform`, and keeps its state in the host it belongs to.
 *
 * Two rules, applied to every file under the host except `electron/` (the one place that adapts Electron)
 * and `index.ts` (the entry that wires it up):
 *  - `electron-import`: no `from 'electron'` (type imports too: they still tie host code to Electron's
 *    types) and no `require('electron')`.
 *  - `module-state`: no top-level `let`/`var`, and no top-level `new Map`/`Set`/`WeakMap`/`WeakSet`/
 *    `AsyncLocalStorage` held in a `const` that is not annotated `ReadonlyMap`/`ReadonlySet`. A second host
 *    in the same process would share such state. The few legitimate cases are in {@link ALLOWED_MODULE_STATE}.
 *
 * `node scripts/check-host-boundary.ts` prints one line per violation and exits non-zero if there is any.
 * Wired into `pnpm check` as `pnpm check:host-boundary`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the host lives, relative to the repo root. */
const HOST_DIR = 'apps/desktop/src/main';

export interface HostBoundaryViolation {
  /** Repo-root-relative, forward slashes. */
  file: string;
  line: number;
  rule: 'electron-import' | 'module-state';
  text: string;
}

export interface AllowedModuleState {
  /** The file's base name, e.g. `serial-session.ts`. */
  file: string;
  /** The top-level binding. */
  name: string;
  reason: string;
}

/** Top-level bindings that may stay, each with why. */
export const ALLOWED_MODULE_STATE: readonly AllowedModuleState[] = [
  {
    file: 'serial-session.ts',
    name: 'loading',
    reason: 'a module cache of an immutable dynamic import',
  },
  {
    file: 'script-host.ts',
    name: 'typeCache',
    reason: 'a WeakMap keyed by objects; holds no host data past its keys',
  },
  {
    file: 'window-scope.ts',
    name: 'caller',
    reason: 'per-call context carrier; holds no host data outside a call',
  },
];

const ELECTRON_IMPORT = /(?:\bfrom\s+['"]electron['"]|\brequire\(\s*['"]electron['"]\s*\))/;
const TOP_LEVEL_LET = /^(?:export\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)/;
const TOP_LEVEL_CONST = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*([^=]+?))?\s*=\s*(.*)$/;
const MUTABLE_HOLDER = /^new\s+(?:Map|Set|WeakMap|WeakSet|AsyncLocalStorage)\b/;
const READONLY_ANNOTATION = /^Readonly(?:Map|Set)\b/;

/** The `.ts`/`.tsx` files under `dir` (recursively), as paths relative to `hostDir`. */
function sourceFiles(hostDir: string): string[] {
  return readdirSync(hostDir, { recursive: true, encoding: 'utf8' })
    .map((file) => file.split('\\').join('/'))
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
    .filter((file) => file !== 'index.ts' && !file.startsWith('electron/'))
    .sort();
}

function isAllowed(file: string, name: string): boolean {
  const base = file.slice(file.lastIndexOf('/') + 1);
  return ALLOWED_MODULE_STATE.some((entry) => entry.file === base && entry.name === name);
}

/** The violations in the host under `root` (the repo root); empty when the host is clean. */
export function findHostBoundaryViolations(root: string): HostBoundaryViolation[] {
  const hostDir = join(root, HOST_DIR);
  if (!existsSync(hostDir)) return [];
  const violations: HostBoundaryViolation[] = [];
  for (const file of sourceFiles(hostDir)) {
    const repoPath = relative(root, join(hostDir, file)).split('\\').join('/');
    const lines = readFileSync(join(hostDir, file), 'utf8').split('\n');
    lines.forEach((text, index) => {
      const line = index + 1;
      const report = (rule: HostBoundaryViolation['rule']): void => {
        violations.push({ file: repoPath, line, rule, text: text.trim() });
      };
      if (ELECTRON_IMPORT.test(text) && !/^\s*(?:\/\/|\*|\/\*)/.test(text)) {
        report('electron-import');
        return;
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
  return violations;
}

function main(): void {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const violations = findHostBoundaryViolations(root);
  if (violations.length === 0) {
    process.stdout.write('host boundary: no electron imports or module state in host code\n');
    return;
  }
  for (const v of violations) {
    process.stderr.write(`${v.file}:${String(v.line)}: ${v.rule}: ${v.text}\n`);
  }
  process.exitCode = 1;
}

// Only run when executed directly, not when the test file imports the function above.
if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  main();
}
