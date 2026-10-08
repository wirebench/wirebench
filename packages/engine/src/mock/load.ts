/**
 * Reads every mock under `mocks/`, for loading a project and for deciding what a save may delete.
 *
 * As for sequences, the two questions share one answer: a file is managed only when this build loaded
 * it. A `mock.yaml` this build refused (too new, malformed, a duplicate id) makes its whole folder
 * foreign; a refused operation or response file is foreign on its own while the rest of its mock loads.
 * A save therefore never deletes, and never silently replaces, a file the user has not seen.
 */

import { join } from 'node:path';
import { isWirebenchError } from '../errors.js';
import { readFileIfExists, readdirIfExists } from '../project/fs.js';
import type { FsLike } from '../project/fs.js';
import {
  DISPATCH_SCRIPT_FILE,
  MOCK_FILE,
  MOCK_OPERATIONS_DIR,
  MOCKS_DIR,
  OPERATION_FILE,
  bodyFilePath,
  parseMockFile,
  parseOperationFile,
  parseResponseFile,
  responseFilePath,
  responseSlugOf,
} from './file.js';
import { MOCK_LIMITS } from './model.js';
import type { MockDef, MockOperation, MockResponse } from './model.js';

/** A mock file that did not load (or loaded only in part), and why. */
export interface MockFileProblem {
  readonly code: 'mock-file-invalid' | 'mock-version-too-new' | 'mock-duplicate-id';
  readonly message: string;
  /** Path relative to the project root. */
  readonly file: string;
}

/** One mock that loaded. */
export interface LoadedMock {
  /** Its folder, relative to the project root. */
  readonly dir: string;
  /** Every file this build read for it: what a save may delete. */
  readonly files: readonly string[];
  readonly mock: MockDef;
}

/** What {@link readMocks} found. */
export interface MockFiles {
  readonly loaded: readonly LoadedMock[];
  readonly problems: readonly MockFileProblem[];
}

const byName = (a: { readonly name: string }, b: { readonly name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const byOrderThenSlug = (a: { order: number; slug: string }, b: { order: number; slug: string }): number =>
  a.order - b.order || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

const PROBLEM_CODES = new Set(['mock-file-invalid', 'mock-version-too-new']);

/** Runs `parse`, turning the codes it is documented to throw into a problem; anything else propagates. */
function attempt<T>(problems: MockFileProblem[], file: string, parse: () => T): T | undefined {
  try {
    return parse();
  } catch (error) {
    if (isWirebenchError(error) && PROBLEM_CODES.has(error.code)) {
      problems.push({ code: error.code as MockFileProblem['code'], message: error.message, file });
      return undefined;
    }
    throw error;
  }
}

interface Budget {
  bodyBytes: number;
}

/**
 * Reads and parses every `mocks/<slug>/mock.yaml` and what it holds. Never throws for a bad file: each
 * becomes a problem and is left out. When two mocks share an id, the first by folder name loads.
 */
export async function readMocks(fs: FsLike, root: string): Promise<MockFiles> {
  const dirs = [...(await readdirIfExists(fs, join(root, MOCKS_DIR)))]
    .filter((entry) => entry.isDirectory)
    .sort(byName);

  const loaded: LoadedMock[] = [];
  const problems: MockFileProblem[] = [];
  const seen = new Map<string, string>();
  for (const entry of dirs) {
    const dir = `${MOCKS_DIR}/${entry.name}`;
    const file = `${dir}/${MOCK_FILE}`;
    const bytes = await readFileIfExists(fs, join(root, file));
    if (bytes === undefined) {
      continue;
    }
    const settings = attempt(problems, file, () => parseMockFile(bytes, file, entry.name));
    if (settings === undefined) {
      continue;
    }
    const first = seen.get(settings.id);
    if (first !== undefined) {
      problems.push({
        code: 'mock-duplicate-id',
        message: `${file} has the same id as ${first}; it was not loaded and is left as it is`,
        file,
      });
      continue;
    }
    seen.set(settings.id, file);
    const files = [file];
    const operations = await readOperations(fs, root, dir, files, problems);
    loaded.push({ dir, files, mock: { ...settings, operations } });
  }
  return { loaded, problems };
}

async function readOperations(
  fs: FsLike,
  root: string,
  mockDir: string,
  files: string[],
  problems: MockFileProblem[],
): Promise<MockOperation[]> {
  const operationsDir = `${mockDir}/${MOCK_OPERATIONS_DIR}`;
  const dirs = [...(await readdirIfExists(fs, join(root, operationsDir)))]
    .filter((entry) => entry.isDirectory)
    .sort(byName);
  const operations: MockOperation[] = [];
  const ids = new Set<string>();
  const budget: Budget = { bodyBytes: 0 };
  for (const entry of dirs) {
    const dir = `${operationsDir}/${entry.name}`;
    const file = `${dir}/${OPERATION_FILE}`;
    const bytes = await readFileIfExists(fs, join(root, file));
    if (bytes === undefined) {
      continue;
    }
    if (operations.length >= MOCK_LIMITS.operations) {
      problems.push({
        code: 'mock-file-invalid',
        message: `${file} was not loaded: a mock holds at most ${MOCK_LIMITS.operations} operations`,
        file,
      });
      continue;
    }
    const settings = attempt(problems, file, () => parseOperationFile(bytes, file, entry.name));
    if (settings === undefined) {
      continue;
    }
    if (ids.has(settings.id)) {
      problems.push({
        code: 'mock-duplicate-id',
        message: `${file} has the same id as another operation of this mock; it was not loaded`,
        file,
      });
      continue;
    }
    ids.add(settings.id);
    files.push(file);

    let script: string | undefined;
    const scriptFile = `${dir}/${DISPATCH_SCRIPT_FILE}`;
    const scriptBytes = await readFileIfExists(fs, join(root, scriptFile));
    if (scriptBytes !== undefined) {
      if (scriptBytes.byteLength > MOCK_LIMITS.scriptBytes) {
        problems.push({
          code: 'mock-file-invalid',
          message: `${scriptFile} is larger than ${MOCK_LIMITS.scriptBytes} bytes; it was left as it is`,
          file: scriptFile,
        });
      } else {
        script = scriptBytes.toString('utf8');
        files.push(scriptFile);
      }
    }

    const responses = await readResponses(fs, root, dir, files, problems, budget);
    let defaultResponseId = settings.defaultResponseId;
    if (defaultResponseId !== undefined && !responses.some((response) => response.id === defaultResponseId)) {
      problems.push({
        code: 'mock-file-invalid',
        message: `${file} names a default response that does not exist; the operation has no default`,
        file,
      });
      defaultResponseId = undefined;
    }
    operations.push({
      id: settings.id,
      name: settings.name,
      slug: settings.slug,
      order: settings.order,
      operation: settings.operation,
      dispatch: settings.dispatch,
      ...(defaultResponseId !== undefined ? { defaultResponseId } : {}),
      ...(script !== undefined ? { script } : {}),
      responses,
    });
  }
  return operations.sort(byOrderThenSlug);
}

async function readResponses(
  fs: FsLike,
  root: string,
  operationDir: string,
  files: string[],
  problems: MockFileProblem[],
  budget: Budget,
): Promise<MockResponse[]> {
  const entries = [...(await readdirIfExists(fs, join(root, operationDir)))]
    .filter((entry) => entry.isFile && responseSlugOf(entry.name) !== undefined)
    .sort(byName);
  const responses: MockResponse[] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    const slug = responseSlugOf(entry.name) ?? entry.name;
    const file = responseFilePath(operationDir, slug);
    if (responses.length >= MOCK_LIMITS.responsesPerOperation) {
      problems.push({
        code: 'mock-file-invalid',
        message: `${file} was not loaded: an operation holds at most ${MOCK_LIMITS.responsesPerOperation} responses`,
        file,
      });
      continue;
    }
    const bytes = await readFileIfExists(fs, join(root, file));
    if (bytes === undefined) {
      continue;
    }
    const settings = attempt(problems, file, () => parseResponseFile(bytes, file, slug));
    if (settings === undefined) {
      continue;
    }
    if (ids.has(settings.id)) {
      problems.push({
        code: 'mock-duplicate-id',
        message: `${file} has the same id as another response of this operation; it was not loaded`,
        file,
      });
      continue;
    }

    let bodyText = '';
    const bodyFile = bodyFilePath(operationDir, slug, settings.body);
    if (bodyFile !== undefined) {
      const body = await readFileIfExists(fs, join(root, bodyFile));
      if (body === undefined) {
        problems.push({
          code: 'mock-file-invalid',
          message: `${bodyFile} is missing; the response loads with an empty body`,
          file: bodyFile,
        });
      } else if (body.byteLength > MOCK_LIMITS.bodyBytes) {
        problems.push({
          code: 'mock-file-invalid',
          message: `${bodyFile} is larger than ${MOCK_LIMITS.bodyBytes} bytes; the response was not loaded`,
          file: bodyFile,
        });
        continue;
      } else if (budget.bodyBytes + body.byteLength > MOCK_LIMITS.totalBodyBytes) {
        problems.push({
          code: 'mock-file-invalid',
          message: `${file} was not loaded: the mock's bodies together exceed ${MOCK_LIMITS.totalBodyBytes} bytes`,
          file,
        });
        continue;
      } else {
        budget.bodyBytes += body.byteLength;
        bodyText = body.toString('utf8');
        files.push(bodyFile);
      }
    }
    ids.add(settings.id);
    files.push(file);
    responses.push({ ...settings, bodyText });
  }
  return responses.sort(byOrderThenSlug);
}
