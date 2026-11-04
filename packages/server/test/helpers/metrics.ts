/**
 * An in-memory metric reader for the metrics tests (hosted edition spec §20.8), and the attribute sweep: every data
 * point of every instrument, checked against `attributes.ts`'s closed set.
 */
import { MetricReader, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { attributeProblem } from '../../src/operations/metrics/attributes.js';
import { startMetrics, type MetricsHandle } from '../../src/operations/metrics/sdk.js';

/** Collects on demand only: `reader.collect()`. */
export class TestReader extends MetricReader {
  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }

  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export interface Point {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly value: unknown;
}

/** The SDK on a fresh reader, as `startServer` starts it with an endpoint set. */
export async function collectingMetrics(
  holder: string,
  version = '0.0.0-test',
): Promise<{ readonly handle: MetricsHandle; readonly reader: TestReader }> {
  const reader = new TestReader();
  const handle = await startMetrics({}, { holder, version }, { reader });
  return { handle, reader };
}

/** What `reader` holds now: the resource, and each instrument's data points by name. */
export async function collect(
  reader: MetricReader,
): Promise<{ readonly resource: ResourceMetrics['resource']; readonly points: Map<string, Point[]> }> {
  const { resourceMetrics, errors } = await reader.collect();
  if (errors.length > 0) throw new AggregateError(errors, 'a metrics callback failed');
  const points = new Map<string, Point[]>();
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      const list = points.get(metric.descriptor.name) ?? [];
      for (const point of metric.dataPoints as readonly Point[]) list.push(point);
      points.set(metric.descriptor.name, list);
    }
  }
  return { resource: resourceMetrics.resource, points };
}

/** Every recorded attribute that is not allowed, as `instrument: key=value (why)`; empty when the sweep is clean. */
export function sweep(points: ReadonlyMap<string, readonly Point[]>): string[] {
  const problems: string[] = [];
  for (const [name, list] of points) {
    for (const point of list) {
      for (const [key, value] of Object.entries(point.attributes)) {
        const problem = attributeProblem(key, value);
        if (problem !== undefined) problems.push(`${name}: ${key}=${String(value)} (${problem})`);
      }
    }
  }
  return problems;
}
