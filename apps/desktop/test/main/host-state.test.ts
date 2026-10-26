/**
 * Per-host state: what used to live in module variables is held by one `HostState` per host, so two
 * hosts in one process never see each other's secrets, batches, outboxes or open calls.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createHostState } from '../../src/main/host/host-state.js';
import { HandlerTable, registerHandler } from '../../src/main/ipc/register.js';
import { defineChannel } from '../../src/shared/ipc-contract.js';
import { fakeCaller } from '../helpers/fake-platform.js';

describe('createHostState', () => {
  it('masks a recorded value in its own host and leaves another host alone', () => {
    const first = createHostState();
    const second = createHostState();
    first.redactor.recordSecretValue('hunter2-token-value');

    const text = 'Authorization-less echo: hunter2-token-value';
    expect(first.redactor.redactSecretValues(text)).not.toContain('hunter2-token-value');
    expect(first.redactor.containsRecordedSecret(text)).toBe(true);
    expect(second.redactor.redactSecretValues(text)).toBe(text);
    expect(second.redactor.containsRecordedSecret(text)).toBe(false);
  });

  it('keeps the xml and byte maskers per host too', () => {
    const first = createHostState();
    const second = createHostState();
    first.redactor.recordSecretValue('s3cr3t-value-xyz');
    const base64 = Buffer.from('a s3cr3t-value-xyz b', 'utf-8').toString('base64');

    expect(first.redactor.redactSecretBytes(base64)).not.toBe(base64);
    expect(second.redactor.redactSecretBytes(base64)).toBe(base64);
    expect(first.redactor.redactSecretValues('<a>s3cr3t-value-xyz</a>', { xml: true })).not.toContain(
      's3cr3t-value-xyz',
    );
    expect(second.redactor.redactSecretValues('<a>s3cr3t-value-xyz</a>', { xml: true })).toContain('s3cr3t-value-xyz');
  });

  it('gives each host its own batches, outboxes and open calls', () => {
    const first = createHostState();
    const second = createHostState();
    expect(first.multiEnvBatches).not.toBe(second.multiEnvBatches);
    expect(first.auditOutboxes).not.toBe(second.auditOutboxes);
    expect(first.openCalls).not.toBe(second.openCalls);
    expect(first.openCalls.ws).not.toBe(second.openCalls.ws);
    expect(first.openCalls.rest).not.toBe(second.openCalls.rest);

    first.multiEnvBatches.set('b', ['x']);
    first.openCalls.ws.set(Promise.resolve(), 'r');
    expect(second.multiEnvBatches.size).toBe(0);
    expect(second.openCalls.ws.size).toBe(0);
  });

  it('starts with the e2e trust anchors unread', () => {
    const state = createHostState();
    expect(state.e2eTrustAnchors).toBeUndefined();
    state.e2eTrustAnchors = ['pem'];
    expect(createHostState().e2eTrustAnchors).toBeUndefined();
  });

  it('masks an error a handler throws with its own table’s redactor only', async () => {
    const boom = defineChannel('test.boom', z.object({}), z.object({}));
    const first = createHostState();
    const second = createHostState();
    first.redactor.recordSecretValue('quoted-secret-value-77');
    const run = async (table: HandlerTable): Promise<unknown> => {
      registerHandler(table, boom, () => Promise.reject(new Error('refused: quoted-secret-value-77')));
      return await table.get('test.boom')?.({}, fakeCaller(1));
    };

    const masked = (await run(new HandlerTable(first.redactor))) as { error: { message: string } };
    const plain = (await run(new HandlerTable(second.redactor))) as { error: { message: string } };
    expect(masked.error.message).not.toContain('quoted-secret-value-77');
    expect(plain.error.message).toContain('quoted-secret-value-77');
  });
});
