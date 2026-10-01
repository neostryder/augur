// `augur-mcp`: an MCP server on standard input and output, for Claude Code, Claude Desktop and other MCP clients. Nothing but the protocol may be written to
// standard output, so anything else goes to standard error.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { augurHome, call, dataDir } from '@augur/augurd';
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
  appendInbox: (lines) => {
    mkdirSync(augurHome(), { recursive: true });
    const path = join(augurHome(), INBOX_FILE), old = (read(INBOX_FILE) ?? '').split('\n').filter(Boolean);
    // The app remembers 500 handled edits, so the inbox keeps fewer and an old edit is never applied twice.
    if (old.length < 300) { appendFileSync(path, lines, 'utf8'); return; }
    writeFileSync(`${path}.tmp`, `${[...old.slice(-250), ...lines.split('\n').filter(Boolean)].join('\n')}\n`, 'utf8');
    renameSync(`${path}.tmp`, path);
  },
  session: `mcp-${randomUUID()}`, cwd: process.cwd(),
});

await buildServer(tools, version).connect(new StdioServerTransport());
process.stderr.write(`augur-mcp ${version} is ready.\n`);
