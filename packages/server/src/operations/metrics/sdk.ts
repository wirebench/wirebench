/**
 * Starts the OpenTelemetry metrics SDK (hosted edition spec §20.8, owner ruling 1): OTLP over HTTP, and only when the
 * operator sets `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`. Without one, the server sends
 * nothing: its instruments sit on `@opentelemetry/api`'s no-op meter, and the SDK, the resources and the exporter are
 * never imported (they load through `import()` below, on the endpoint's path only).
 *
 * The standard `OTEL_*` variables apply as the SDK reads them: the exporter reads the endpoint, headers, timeout and
 * temporality from `process.env` itself, and the resource takes `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`
 * through the SDK's environment detector. The periodic reader reads none, so `OTEL_METRIC_EXPORT_INTERVAL` and
 * `OTEL_METRIC_EXPORT_TIMEOUT` are read here. `config.ts` parses none of them. No global provider is registered, so
 * the exporter's own self-observation stays on the API's no-op provider and never reaches this one.
 *
 * `@opentelemetry/api` itself is imported statically: it is small, side-effect free, and its no-op meter is what an
 * unset endpoint runs on.
 */
import { createNoopMeter } from '@opentelemetry/api';
import type { MetricReader } from '@opentelemetry/sdk-metrics';
import { ServerMetrics } from './instruments.js';

export const DEFAULT_SERVICE_NAME = 'wirebench-server';
/** How long a shutdown waits for the last export: a collector that does not answer must not hold the process. */
export const METRICS_FLUSH_MS = 5_000;

export interface MetricsIdentity {
  /** `ctx.instance.holder`: the `service.instance.id`. */
  readonly holder: string;
  readonly version: string;
}

export interface MetricsHandle {
  readonly metrics: ServerMetrics;
  /** Whether the SDK runs: an endpoint is set, or a test gave a reader. */
  readonly exporting: boolean;
  /** Flushes the last numbers and stops, waiting at most `timeoutMs`. Never rejects; idempotent. */
  shutdown(timeoutMs?: number): Promise<void>;
}

export interface StartMetricsOptions {
  /** Test only: collect into this reader instead of exporting over OTLP; starts the SDK with no endpoint set. */
  readonly reader?: MetricReader;
  /** Told when the last flush fails or runs out of time; the server logs it. */
  readonly warn?: (message: string, error?: unknown) => void;
}

const set = (value: string | undefined): boolean => value !== undefined && value.trim() !== '';

/** Whether the operator asked for metrics: one of the two OTLP endpoint variables is set (spec §20.8). */
export function metricsEndpointSet(env: NodeJS.ProcessEnv): boolean {
  return set(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) || set(env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

/** A positive whole number of milliseconds from `value`, or `undefined` for anything else. */
function millis(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  const ms = Number(value.trim());
  return ms > 0 ? ms : undefined;
}

/** The no-op handle: what a server without an endpoint, and every test that builds a context, runs on. */
export function noopMetrics(): MetricsHandle {
  return { exporting: false, metrics: new ServerMetrics(createNoopMeter()), shutdown: () => Promise.resolve() };
}

/**
 * The server's metrics. `env` decides whether the SDK starts; in production it is `process.env`, which the exporter
 * reads too.
 */
export async function startMetrics(
  env: NodeJS.ProcessEnv,
  identity: MetricsIdentity,
  options: StartMetricsOptions = {},
): Promise<MetricsHandle> {
  if (options.reader === undefined && !metricsEndpointSet(env)) return noopMetrics();
  const [{ MeterProvider, PeriodicExportingMetricReader }, resources] = await Promise.all([
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/resources'),
  ]);
  let reader = options.reader;
  if (reader === undefined) {
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http');
    const interval = millis(env.OTEL_METRIC_EXPORT_INTERVAL);
    const timeout = millis(env.OTEL_METRIC_EXPORT_TIMEOUT);
    reader = new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      ...(interval !== undefined ? { exportIntervalMillis: interval } : {}),
      // The reader refuses a timeout longer than its interval.
      ...(timeout !== undefined ? { exportTimeoutMillis: Math.min(timeout, interval ?? 60_000) } : {}),
    });
  }
  // The default name, then the operator's (`OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`), then what only this
  // process knows: its holder and version always win.
  const resource = resources
    .resourceFromAttributes({ 'service.name': DEFAULT_SERVICE_NAME })
    .merge(resources.detectResources({ detectors: [resources.envDetector] }))
    .merge(
      resources.resourceFromAttributes({ 'service.instance.id': identity.holder, 'service.version': identity.version }),
    );
  const provider = new MeterProvider({ resource, readers: [reader] });
  const metrics = new ServerMetrics(provider.getMeter('wirebench-server', identity.version));
  let stopping: Promise<void> | undefined;
  return {
    metrics,
    exporting: true,
    shutdown: (timeoutMs = METRICS_FLUSH_MS) => {
      stopping ??= provider.shutdown({ timeoutMillis: Math.max(1, timeoutMs) }).catch((error: unknown) => {
        options.warn?.('the last metrics could not be exported', error);
      });
      return stopping;
    },
  };
}
