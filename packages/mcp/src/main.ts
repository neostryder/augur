// `augur-mcp`: an MCP server on standard input and output, for Claude Code, Claude Desktop and other MCP clients. Nothing but the protocol may be written to
// standard output, so anything else goes to standard error.
import { stampFromEnv } from '@augur/dispatch-protocol';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
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
const stamp = { ...stampFromEnv({ ...process.env, AUGUR_SESSION: process.env.AUGUR_SESSION ?? process.env.CLAUDE_CODE_SESSION_ID }, 'mcp'), origin: 'mcp' as const, originLabel: 'augur-mcp', host: hostname(), pid: process.pid, parentPid: process.ppid };
const tools = createTools({
  stamp,
  call, opts: { dir, role: 'agent' as const, ...(process.env.AUGURD_PIPE ? { pipe: process.env.AUGURD_PIPE } : {}) },
  policyText: () => read('policy.json'), usageText: () => read('usage.json'), inboxText: () => read(INBOX_FILE), editStateText: () => read(RESULTS_FILE),
  aliasStateText: () => read('alias-refresh.json'), aliasInboxText: () => read('alias-inbox.jsonl'), aliasFlagsText: () => read('alias-flags.json'),
  appendInbox: (lines) => appendPolicyEdits(lines),
  session: stamp.sessionId ?? `mcp-${randomUUID()}`, cwd: process.cwd(),
});

await buildServer(tools, version).connect(new StdioServerTransport());
process.stderr.write(`augur-mcp ${version} is ready.\n`);
