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
  /** Text the generated reference shows after the options table, for behavior that no single option controls. */
  notes?: string;
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
const ambient: OptionSpec = { key: 'ambient', label: 'Harness context', kind: 'choice', choices: ['keep', 'trim'], help: "Whether the harness loads its own extra instructions, tools and plugins on this route. trim turns them off, keep leaves them on, and Default follows the service's Harness context setting." };

const apiExtras: OptionSpec[] = [
  { key: 'headersJson', label: 'Extra headers', kind: 'json', help: 'A JSON object of request headers sent with every call. Credentials do not belong here; keep keys in the key store.', placeholder: '{"x-team": "home"}' },
  { key: 'requestClass', label: 'Priority class', kind: 'choice', choices: ['none', 'cogitator'], help: 'none sends nothing. cogitator sends x-cogitator-class with every call: low for background jobs, normal for a person typing at a terminal or a job marked urgent.' },
  { key: 'maxInput', label: 'Largest prompt', kind: 'number', help: 'The most characters of prompt, with any text attachments, the route takes. A bigger job is refused and goes to the route fallback, and is never cut. Leave empty for no limit.' },
  { key: 'maxImageMb', label: 'Largest image', kind: 'number', help: 'The largest image attachment in megabytes. Defaults to 10.' },
  { key: 'maxAudioMb', label: 'Largest audio file', kind: 'number', help: 'The largest audio attachment in megabytes. Defaults to 25.' }];

export const ADAPTER_INFO: readonly AdapterInfo[] = [
  { id: 'codex-exec', label: 'Codex CLI', summary: 'Runs codex exec. A read-only job is stated in the prompt, and Codex is not held to it. A named conversation resumes the same Codex session and keeps the tool tier of its first turn.',
    options: [{ key: 'model', label: 'Model', kind: 'text', help: 'Passed to codex as its model. Leave empty for the model codex chooses.' }, effort, command,
      { key: 'sandbox', label: 'Codex sandbox', kind: 'choice', choices: ['read-only', 'workspace-write', 'danger-full-access'], help: 'The sandbox codex runs in. On Windows the stricter ones can fail to start, which is why the default is danger-full-access.' },
      { key: 'prefixArgsJson', label: 'Arguments before exec', kind: 'json', help: 'A JSON array of arguments placed before exec, for wrappers.' }, ambient] },
  { id: 'copilot-exec', label: 'GitHub Copilot CLI', summary: 'Runs the Copilot CLI in prompt mode with all tools allowed, so a read-only job is stated in the prompt and not enforced.',
    options: [model('The Copilot model id, for example claude-opus-5.5.', 'claude-opus-5.5'), command, effort, envAllow, ambient] },
  { id: 'grok-exec', label: 'Grok CLI', summary: 'Runs the Grok CLI, which has a real read mode, so a read job is held to reading. A named conversation resumes the same Grok session.',
    options: [model('The Grok model id.', 'grok-4.7'), effort, { key: 'maxTurns', label: 'Turn limit', kind: 'number', help: 'Most turns a job may take. Defaults to 60 for a read job and 400 otherwise.' }, command, envAllow] },
  { id: 'hermes-exec', label: 'Hermes Agent', summary: 'Runs the Hermes command line with a prompt and reads its usage file.',
    options: [model('The model id Hermes passes to its provider.'), command, envAllow] },
  { id: 'mcode-sbx', label: 'mcode in a Docker sandbox', summary: 'Runs mcode inside a Docker sandbox on a copy of the job folder, and returns changes as a patch.',
    options: [sandbox, workRoot, model('The model id mcode uses.'), effort,
      { key: 'maxSteps', label: 'Step limit', kind: 'number', help: 'Most steps a job may take. Defaults to 60 for a read job and 400 otherwise.' }, sbx, sbxPrefixJson, envAllow] },
  { id: 'opencode-sbx', label: 'OpenCode in a Docker sandbox', summary: 'Runs OpenCode inside a Docker sandbox on a copy of the job folder, and returns changes as a patch.',
    options: [sandbox, workRoot, model('The provider/model id OpenCode uses.', 'openrouter/deepseek-v4.1-flash'), effort, sbx, sbxPrefixJson, envAllow] },
  { id: 'openai-api', label: 'OpenAI-style API', summary: 'Sends one prompt to a chat completions, embeddings, or transcription endpoint and returns the text. No tools. Text files and images can go with the prompt.',
    notes: "A local gateway such as Cogitator answers HTTP 503 with the error code `preempted` when it hands its model to a person's request. The API call then waits for the number of seconds in the `Retry-After` header (20 if the header is missing, 120 at most) and sends the request again, for up to three tries in all while the job's `timeoutS` still has time left. If every try comes back preempted, the call fails with an error message starting `preempted:`. Augur treats that error like a provider limit and moves the job to the route's fallback whatever its tool tier, since none of the job ran.",
    options: [{ key: 'baseUrl', label: 'Base URL', kind: 'text', required: true, help: 'The API address up to and including /v1. It must start with https://, or http:// for this computer or a machine on the home network.', placeholder: 'https://api.openai.com/v1' },
      model('The model id the endpoint expects.'),
      { key: 'keySource', label: 'Key kept in', kind: 'choice', choices: ['env', 'store'], help: "Pick env to read the key from an environment variable you name, or store to keep it in this computer's key store. A stored key is saved on the Routes page or with `augur key set <route>`." },
      { key: 'apiKeyEnv', label: 'Key variable', kind: 'text', required: true, help: 'The name of the environment variable that holds the API key, when Key kept in is set to env. The key itself is never stored in a route.' },
      { key: 'mode', label: 'Request type', kind: 'choice', choices: ['chat', 'embeddings', 'transcribe', 'moderation'], help: 'chat, the default, sends the prompt as a chat. embeddings sends the prompt and any text files to the embeddings endpoint, up to 256 inputs. A prompt that is a JSON array of strings counts as one input per string. The answer is a JSON object with the model, the vector length, and the vectors in input order, and the job folder keeps a copy. transcribe sends an audio file to the transcription endpoint. moderation sends the prompt and any text or image files to the moderations endpoint and answers with a JSON object holding the overall verdict, the per-category flags, and the raw per-category scores.' },
      { key: 'dimensions', label: 'Vector length', kind: 'number', help: 'For an embeddings route, the number of values in each vector. Callers read it from the route so they can tell when stored vectors no longer match.' },
      { key: 'maxTokens', label: 'Token limit', kind: 'number', help: 'Most tokens the answer may use. Defaults to 4096.' },
      { key: 'timeoutS', label: 'Timeout in seconds', kind: 'number', help: 'Defaults to 900.' }, ...apiExtras] },
  { id: 'anthropic-api', label: 'Anthropic-style API', summary: 'Sends one prompt to a messages endpoint and returns the text. No tools. Text files and images can go with the prompt.',
    options: [{ key: 'baseUrl', label: 'Base URL', kind: 'text', required: true, help: 'The API address. It must start with https://, or http:// for this computer or a machine on the home network.', placeholder: 'https://api.anthropic.com' },
      model('The model id the endpoint expects.'),
      { key: 'keySource', label: 'Key kept in', kind: 'choice', choices: ['env', 'store'], help: "Pick env to read the key from an environment variable you name, or store to keep it in this computer's key store. A stored key is saved on the Routes page or with `augur key set <route>`." },
      { key: 'apiKeyEnv', label: 'Key variable', kind: 'text', required: true, help: 'The name of the environment variable that holds the API key, when Key kept in is set to env. The key itself is never stored in a route.' },
      { key: 'maxTokens', label: 'Token limit', kind: 'number', help: 'Most tokens the answer may use. Defaults to 4096.' },
      { key: 'timeoutS', label: 'Timeout in seconds', kind: 'number', help: 'Defaults to 900.' }, ...apiExtras] },
  { id: 'fal-api', label: 'fal video', summary: 'Sends a prompt, and optionally a first frame, a last frame, and an audio track, to a fal video endpoint and saves the finished video in the job folder. The cost is checked against the route limit before anything is sent.',
    options: [{ key: 'endpoint', label: 'Endpoint', kind: 'text', required: true, help: 'The fal endpoint id.', placeholder: 'minimax/h3-max-turbo/image-to-video' },
      { key: 'usdPerSecondJson', label: 'Price per second', kind: 'json', required: true, help: 'A JSON object with the price in US dollars for one second of video at each resolution. Augur multiplies it by the length to check the cost before sending a job, and reports it as the job cost.', placeholder: '{"768P": 0.1, "1080P": 0.2}' },
      { key: 'keySource', label: 'Key kept in', kind: 'choice', choices: ['store', 'env'], help: "store, the default, reads the key from this computer's key store, saved with `augur key set <route>`. env reads it from an environment variable you name." },
      { key: 'apiKeyEnv', label: 'Key variable', kind: 'text', help: 'The name of the environment variable that holds the key, when Key kept in is set to env. The key itself is never stored in a route.' },
      { key: 'resolution', label: 'Resolution', kind: 'choice', choices: ['480P', '768P', '1080P'], help: 'Defaults to 768P.' },
      { key: 'duration', label: 'Length in seconds', kind: 'number', help: 'Defaults to 5.' },
      { key: 'promptExpansion', label: 'Prompt expansion', kind: 'choice', choices: ['disabled', 'balanced', 'quality'], help: 'How much fal rewrites the prompt before it makes the video. Defaults to balanced.' },
      { key: 'maxUsd', label: 'Limit per job in dollars', kind: 'number', help: 'A job whose estimated cost passes this is refused before it is sent. Defaults to 0.50.' },
      { key: 'timeoutS', label: 'Timeout in seconds', kind: 'number', help: 'Defaults to 900. A job still waiting then is cancelled.' },
      { key: 'maxImageMb', label: 'Largest image', kind: 'number', help: 'The largest image attachment in megabytes. Defaults to 10.' },
      { key: 'maxAudioMb', label: 'Largest audio file', kind: 'number', help: 'The largest audio attachment in megabytes. Defaults to 25.' }] },
  { id: 'exec', label: 'Any command', summary: 'Runs any command the route names, with no checks on what it does. It is off unless the service settings list it.',
    options: [{ key: 'command', label: 'Command', kind: 'text', required: true, help: 'The program to run.' },
      { key: 'argsJson', label: 'Arguments', kind: 'json', help: 'A JSON array of arguments.', placeholder: '["--flag", "value"]' },
      { key: 'stdin', label: 'Prompt goes to', kind: 'choice', choices: ['prompt', 'none'], help: 'Whether the command reads the prompt on standard input.' }] },
];

export const adapterInfo = (id: string): AdapterInfo | undefined => ADAPTER_INFO.find(a => a.id === id);
