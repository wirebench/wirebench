// An MCP server over stdio for e2e/specs/mcp-request.spec.ts (#79): `node server.mjs`.
//
// Plain newline-delimited JSON-RPC with no imports beyond Node's own, so the launched app can run it
// from wherever the e2e package sits without resolving an SDK. It advertises two tools: `echo`
// answers with its `text` argument, and `fail` answers with `isError: true`. Anything else that
// carries an id is answered -32601; notifications are ignored.
import { createInterface } from 'node:readline';

const TOOLS = [
  {
    name: 'echo',
    description: 'Echoes its text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
];

const write = (message) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
};

function answer(method, params) {
  if (method === 'initialize') {
    return {
      protocolVersion: params?.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'e2e-fixture', version: '1.0.0' },
    };
  }
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call' && params?.name === 'echo') {
    const text = typeof params.arguments?.text === 'string' ? params.arguments.text : '';
    return { content: [{ type: 'text', text: `echo: ${text}` }] };
  }
  if (method === 'tools/call' && params?.name === 'fail') {
    return { content: [{ type: 'text', text: 'the fixture tool failed on purpose' }], isError: true };
  }
  return undefined;
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined || typeof message.method !== 'string') return;
  const result = answer(message.method, message.params);
  if (result === undefined) {
    write({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
    return;
  }
  write({ id: message.id, result });
});
// Like a well-behaved server, stop when the client ends stdin.
lines.on('close', () => {
  process.exit(0);
});
