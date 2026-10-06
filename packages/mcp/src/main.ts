// `augur-mcp`: an MCP server on standard input and output, for Claude Code, Claude Desktop and other MCP clients. Nothing but the protocol may be written to
// standard output, so anything else goes to standard error.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { appendPolicyEdits, augurHome, call, dataDir } from '@augur/augurd';
import { INBOX_FILE, RESULTS_FILE } from '@augur/core';
import { buildServer } from './server.js';
import { createTools } from './tools.js';

declare const __AUGUR_VERSION__: string | undefined;
const version = typeof __AUGUR_VERSION__ === 'string' ? __AUGUR_VERSION__ : 'dev';

const dir = dataDir();
const read = (name: string): string | null => { try { return readFileSync(join(augurHome(), name), 'utf8'); } catch { return null; } };
const tools = createTools({
  call, opts: { dir, ...(process.env.AUGURD_PIPE ? { pipe: process.env.AUGURD_PIPE } : {}) },
  policyText: () => read('policy.json'), usageText: () => read('usage.json'), inboxText: () => read(INBOX_FILE), editStateText: () => read(RESULTS_FILE),
  appendInbox: (lines) => appendPolicyEdits(lines),
  session: `mcp-${randomUUID()}`, cwd: process.cwd(),
});

await buildServer(tools, version).connect(new StdioServerTransport());
process.stderr.write(`augur-mcp ${version} is ready.\n`);
