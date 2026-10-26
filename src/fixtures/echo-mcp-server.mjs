// A tiny MCP server for mcp.test.js: one tool that echoes its text, and one that always fails.
// It also reports whether it can see OPENROUTER_API_KEY - it must not (quantess starts servers with a safe env).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo', version: '1.0.0' });
server.tool('echo', 'Echo the text back', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text: `echo: ${text} | key visible: ${Boolean(process.env.OPENROUTER_API_KEY)} | extra: ${process.env.ECHO_EXTRA ?? 'none'}` }]
}));
server.tool('fail', 'Always fails', {}, async () => ({ isError: true, content: [{ type: 'text', text: 'it broke on purpose' }] }));
// A chatty server: floods stderr the way npx banners and debug logs do (code review 10-23: nobody read it, it froze)
if (process.env.ECHO_NOISY) setInterval(() => process.stderr.write('x'.repeat(50_000)), 10);
await server.connect(new StdioServerTransport());
