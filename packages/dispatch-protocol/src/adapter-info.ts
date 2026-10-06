// What a person sees when they set up a route: each adapter's name, what it does, and the route options it reads. The Routes page draws its form from this.
// A test in the service package checks that every adapter has an entry and that each required option is one the adapter refuses to run without.

export interface OptionSpec {
  key: string;
  label: string;
  help: string;
  kind: 'text' | 'number' | 'choice' | 'json';
  required?: boolean;
  choices?: string[];
  placeholder?: string;
}

export interface AdapterInfo {
  id: string;
  label: string;
  /** One or two sentences: what runs, and what it cannot be held to. */
  summary: string;
  options: OptionSpec[];
}

const model = (help: string, placeholder?: string): OptionSpec => ({ key: 'model', label: 'Model', kind: 'text', required: true, help, ...(placeholder ? { placeholder } : {}) });
const effort: OptionSpec = { key: 'effort', label: 'Reasoning effort', kind: 'text', help: 'Passed to the harness as its effort setting. Leave empty for its default.', placeholder: 'high' };
const command: OptionSpec = { key: 'command', label: 'Command', kind: 'text', help: 'Full path to the harness, for when it is not on the search path.' };
const envAllow: OptionSpec = { key: 'envAllow', label: 'Extra environment', kind: 'text', help: 'Names of environment variables the harness may read, separated by commas. Nothing else from the service is passed on.' };
const sandbox: OptionSpec = { key: 'sandbox', label: 'Sandbox name', kind: 'text', required: true, help: 'The Docker sandbox the harness runs inside.' };
const workRoot: OptionSpec = { key: 'workRoot', label: 'Sandbox workspace', kind: 'text', required: true, help: 'The folder on this computer that the sandbox mounts as its workspace. Each job gets a copy of its folder there.' };
const sbx: OptionSpec = { key: 'sbx', label: 'sbx command', kind: 'text', help: 'Full path to the sbx command, for when it is not on the search path.' };
const sbxPrefixJson: OptionSpec = { key: 'sbxPrefixJson', label: 'sbx arguments', kind: 'json', help: 'A JSON array of arguments placed before every sbx call, for wrappers.' };

export const ADAPTER_INFO: readonly AdapterInfo[] = [
  { id: 'codex-exec', label: 'Codex CLI', summary: 'Runs codex exec. A read-only job is stated in the prompt, and Codex is not held to it.',
    options: [{ key: 'model', label: 'Model', kind: 'text', help: 'Passed to codex as its model. Leave empty for the model codex chooses.' }, effort, command,
      { key: 'sandbox', label: 'Codex sandbox', kind: 'choice', choices: ['read-only', 'workspace-write', 'danger-full-access'], help: 'The sandbox codex runs in. On Windows the stricter ones can fail to start, which is why the default is danger-full-access.' },
      { key: 'prefixArgsJson', label: 'Arguments before exec', kind: 'json', help: 'A JSON array of arguments placed before exec, for wrappers.' }] },
  { id: 'copilot-exec', label: 'GitHub Copilot CLI', summary: 'Runs the Copilot CLI in prompt mode with all tools allowed, so a read-only job is stated in the prompt and not enforced.',
    options: [model('The Copilot model id, for example claude-opus-5.5.', 'claude-opus-5.5'), command, effort, envAllow] },
  { id: 'grok-exec', label: 'Grok CLI', summary: 'Runs the Grok CLI, which has a real read mode, so a read job is held to reading.',
    options: [model('The Grok model id.', 'grok-4.7'), effort, { key: 'maxTurns', label: 'Turn limit', kind: 'number', help: 'Most turns a job may take. Defaults to 60 for a read job and 400 otherwise.' }, command, envAllow] },
  { id: 'hermes-exec', label: 'Hermes Agent', summary: 'Runs the Hermes command line with a prompt and reads its usage file.',
    options: [model('The model id Hermes passes to its provider.'), command, envAllow] },
  { id: 'mcode-sbx', label: 'mcode in a Docker sandbox', summary: 'Runs mcode inside a Docker sandbox on a copy of the job folder, and returns changes as a patch.',
    options: [sandbox, workRoot, model('The model id mcode uses.'), effort,
      { key: 'maxSteps', label: 'Step limit', kind: 'number', help: 'Most steps a job may take. Defaults to 60 for a read job and 400 otherwise.' }, sbx, sbxPrefixJson, envAllow] },
  { id: 'opencode-sbx', label: 'OpenCode in a Docker sandbox', summary: 'Runs OpenCode inside a Docker sandbox on a copy of the job folder, and returns changes as a patch.',
    options: [sandbox, workRoot, model('The provider/model id OpenCode uses.', 'openrouter/deepseek-v4.1-flash'), sbx, sbxPrefixJson, envAllow] },
  { id: 'openai-api', label: 'OpenAI-style API', summary: 'Sends one prompt to a chat completions endpoint and returns the text. No tools and no files.',
    options: [{ key: 'baseUrl', label: 'Base URL', kind: 'text', required: true, help: 'The API address up to and including /v1. It must start with https://, or http:// for localhost.', placeholder: 'https://api.openai.com/v1' },
      model('The model id the endpoint expects.'),
      { key: 'keySource', label: 'Key kept in', kind: 'choice', choices: ['env', 'store'], help: "Pick env to read the key from an environment variable you name, or store to keep it in this computer's key store. A stored key is saved on the Routes page or with `augur key set <route>`." },
      { key: 'apiKeyEnv', label: 'Key variable', kind: 'text', required: true, help: 'The name of the environment variable that holds the API key, when Key kept in is set to env. The key itself is never stored in a route.' },
      { key: 'maxTokens', label: 'Token limit', kind: 'number', help: 'Most tokens the answer may use. Defaults to 4096.' },
      { key: 'timeoutS', label: 'Timeout in seconds', kind: 'number', help: 'Defaults to 900.' }] },
  { id: 'anthropic-api', label: 'Anthropic-style API', summary: 'Sends one prompt to a messages endpoint and returns the text. No tools and no files.',
    options: [{ key: 'baseUrl', label: 'Base URL', kind: 'text', required: true, help: 'The API address. It must start with https://, or http:// for localhost.', placeholder: 'https://api.anthropic.com' },
      model('The model id the endpoint expects.'),
      { key: 'keySource', label: 'Key kept in', kind: 'choice', choices: ['env', 'store'], help: "Pick env to read the key from an environment variable you name, or store to keep it in this computer's key store. A stored key is saved on the Routes page or with `augur key set <route>`." },
      { key: 'apiKeyEnv', label: 'Key variable', kind: 'text', required: true, help: 'The name of the environment variable that holds the API key, when Key kept in is set to env. The key itself is never stored in a route.' },
      { key: 'maxTokens', label: 'Token limit', kind: 'number', help: 'Most tokens the answer may use. Defaults to 4096.' },
      { key: 'timeoutS', label: 'Timeout in seconds', kind: 'number', help: 'Defaults to 900.' }] },
  { id: 'exec', label: 'Any command', summary: 'Runs any command the route names, with no checks on what it does. It is off unless the service settings list it.',
    options: [{ key: 'command', label: 'Command', kind: 'text', required: true, help: 'The program to run.' },
      { key: 'argsJson', label: 'Arguments', kind: 'json', help: 'A JSON array of arguments.', placeholder: '["--flag", "value"]' },
      { key: 'stdin', label: 'Prompt goes to', kind: 'choice', choices: ['prompt', 'none'], help: 'Whether the command reads the prompt on standard input.' }] },
];

export const adapterInfo = (id: string): AdapterInfo | undefined => ADAPTER_INFO.find(a => a.id === id);
