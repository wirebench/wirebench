/**
 * The registry of open interactive gRPC calls `EngineService` keeps beside its in-flight sends.
 *
 * A push or a half-close names a call by the same `sendId` its send used, which means both can
 * arrive for a call that has already ended — the user hit Send again, the deadline passed, the
 * server hung up. Neither may reach a dead stream, so this is what each answers instead.
 */
import { describe, expect, it } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';

describe('an interactive gRPC call that is not open', () => {
  it('refuses a push naming a call that is not open', () => {
    const service = new EngineService();

    expect(() => service.pushGrpcMessage('never-opened', '{}')).toThrow(WirebenchError);
    try {
      service.pushGrpcMessage('never-opened', '{}');
    } catch (error) {
      expect((error as WirebenchError).code).toBe('grpc-stream-unknown');
    }
  });

  it('answers a half-close for a call that is not open rather than throwing', () => {
    const service = new EngineService();

    expect(service.halfCloseGrpc('never-opened')).toEqual({ closed: false });
  });
});
