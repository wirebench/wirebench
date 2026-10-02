/**
 * The dependencies of a desktop send through the engine (`sendThroughEngine`), over one in-memory
 * project: what a test that sends a saved request needs, and nothing it does not ask for.
 */
import type { Project } from '@wirebench/engine';
import { EngineService } from '../../src/main/engine-service.js';
import { ExchangeRegistry, type SendThroughEngineDeps } from '../../src/main/send/exchange.js';

type ProjectSurface = SendThroughEngineDeps['project'];

export interface SendDepsExtra extends Partial<Omit<SendThroughEngineDeps, 'project'>> {
  /** The project folder files and keystores are read from. */
  readonly projectDir?: string;
  /** Members of the project surface laid over the stub's (a contract lookup, cookies, meta). */
  readonly project?: Partial<ProjectSurface>;
}

export function sendDepsFor(model: Project, extra: SendDepsExtra = {}): SendThroughEngineDeps {
  const { projectDir, project, ...rest } = extra;
  return {
    service: new EngineService(),
    registry: new ExchangeRegistry(),
    project: {
      projectId: () => model.id,
      runContextFor: () => ({ project: model, projectDir: projectDir ?? '/tmp/none' }),
      restMeta: () => undefined,
      requestMeta: () => undefined,
      ...project,
    } as unknown as ProjectSurface,
    ...rest,
  };
}
