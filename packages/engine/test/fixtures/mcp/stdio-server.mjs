// An MCP server over stdio for the MCP kind's tests (#79). `node stdio-server.mjs <mode>`.
//
// `sdk` (the default) is the SDK's own McpServer with three tools: `echo` returns its `text`,
// `fail` answers with `isError: true`, and `env` returns the variables it was given. `sdk-prompts`
// advertises prompts only, so a tools call must be refused before it is sent.
//
// The other modes misbehave by hand, which the SDK's server will not do:
//   silent        reads stdin and never answers;
//   crash         writes to stderr and exits with code 3 at once;
//   exit-mid      answers initialize, then exits with code 2 on the operation;
//   roots         asks the client for roots/list before answering tools/list, and returns the reply;
//   invalid       sends a non-JSON line and a malformed message before answering;
//   big           answers the operation with a line over 4 MiB;
//   old-version   answers initialize with a protocol version no client supports;
//   stubborn      never answers, ignores SIGTERM and stays up when stdin ends.
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'sdk';

if (mode === 'sdk' || mode === 'sdk-prompts') {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const server = new McpServer({ name: 'fixture', version: '1.2.3' });
  if (mode === 'sdk') {
    server.registerTool('echo', { description: 'Echoes its text', inputSchema: { text: z.string() } }, ({ text }) => ({
      content: [{ type: 'text', text }],
    }));
    server.registerTool('fail', { description: 'Always fails' }, () => ({
      content: [{ type: 'text', text: 'it went wrong' }],
      isError: true,
    }));
    server.registerTool('env', { description: 'Lists its environment' }, () => ({
      content: [{ type: 'text', text: JSON.stringify({ env: process.env, cwd: process.cwd() }) }],
    }));
  } else {
    server.registerPrompt('greet', { description: 'Says hello' }, () => ({
      messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
    }));
  }
  await server.connect(new StdioServerTransport());
} else {
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const initResult = (version) => ({
    protocolVersion: version,
    capabilities: { tools: {} },
    serverInfo: { name: 'raw', version: '0.0.1' },
  });

  if (mode === 'crash') {
    process.stderr.write('fixture: starting\nfixture: cannot open the database\n');
    process.exit(3);
  }
  if (mode === 'stubborn') {
    process.on('SIGTERM', () => undefined);
    setInterval(() => undefined, 1_000);
  }

  let waitingForRoots;
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (mode === 'silent' || mode === 'stubborn') return;
    if (message.method === 'initialize') {
      write({ jsonrpc: '2.0', id: message.id, result: initResult(mode === 'old-version' ? '1999-01-01' : message.params.protocolVersion) });
      return;
    }
    if (message.id === 'roots-1' && waitingForRoots !== undefined) {
      write({ jsonrpc: '2.0', id: waitingForRoots, result: { tools: [], reply: message } });
      return;
    }
    if (message.method === undefined || message.method.startsWith('notifications/')) return;
    if (mode === 'exit-mid') {
      process.stderr.write('fixture: giving up\n');
      process.exit(2);
    }
    if (mode === 'roots') {
      waitingForRoots = message.id;
      write({ jsonrpc: '2.0', id: 'roots-1', method: 'roots/list' });
      return;
    }
    if (mode === 'invalid') {
      process.stdout.write('this is not json\n');
      write({ jsonrpc: '2.0', method: 42 });
    }
    if (mode === 'big') {
      write({ jsonrpc: '2.0', id: message.id, result: { tools: [], padding: 'x'.repeat(4 * 1024 * 1024 + 10) } });
      return;
    }
    write({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
  });
  // Like a well-behaved server, stop when the client ends stdin (except the stubborn one).
  lines.on('close', () => {
    if (mode !== 'stubborn') process.exit(0);
  });
}
