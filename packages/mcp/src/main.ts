// `augur-mcp`: an MCP server on standard input and output, for Claude Code, Claude Desktop and other MCP clients. Nothing but the protocol may be written to
// standard output, so anything else goes to standard error.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { augurHome, call, dataDir } from '@augur/augurd';
import { buildServer } from './server.js';
import { createTools } from './tools.js';

declare const __AUGUR_VERSION__: string | undefined;
const version = typeof __AUGUR_VERSION__ === 'string' ? __AUGUR_VERSION__ : 'dev';

const dir = dataDir();
const tools = createTools({
  call, opts: { dir, ...(process.env.AUGURD_PIPE ? { pipe: process.env.AUGURD_PIPE } : {}) },
  policyText: () => { try { return readFileSync(join(augurHome(), 'policy.json'), 'utf8'); } catch { return null; } },
  session: `mcp-${randomUUID()}`, cwd: process.cwd(),
});

await buildServer(tools, version).connect(new StdioServerTransport());
process.stderr.write(`augur-mcp ${version} is ready.\n`);
