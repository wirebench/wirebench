import { describe, expect, it } from 'vitest';
import { SKIP_PERF } from '../bench/budgets.js';
import { createFrameChecker } from '../../src/asyncapi/frame-check.js';
import { parseAsyncApi } from '../../src/asyncapi/parse.js';
import type { WsFrame } from '../../src/ws/model.js';
import { fileFetch } from '../helpers/file-fetch.js';

const fixture = new URL('../fixtures/asyncapi/chat-2.6.yaml', import.meta.url);

describe.skipIf(SKIP_PERF)('asyncapi frame check', () => {
  it('10 000 received 2 KiB frames check in under 500 ms', { retry: 1 }, async () => {
    const { document } = await parseAsyncApi({ kind: 'file', path: fixture.href }, { fetchDocument: fileFetch });
    const check = createFrameChecker(document, '/chat/{roomId}');
    const body = JSON.stringify({ type: 'message', from: 'a', text: 'x'.repeat(2000) });
    const frames: WsFrame[] = Array.from({ length: 10_000 }, (_, i) => ({
      index: i,
      direction: 'received',
      opcode: 'text',
      at: i,
      size: body.length,
      text: body,
    }));
    check(frames[0]!);
    const start = performance.now();
    for (const f of frames) check(f);
    const ms = performance.now() - start;
    expect(ms).toBeLessThan(500);
  });
});
