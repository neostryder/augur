import { describe, expect, it } from 'vitest';
import { describeCapabilities } from '@augur/dispatch-protocol';
import type { RouteConfig } from '@augur/dispatch-protocol';
import { Supervisor } from '../src/supervisor.js';
import { enabledAdapters } from '../src/adapters/index.js';

const adapters = enabledAdapters(['codex-exec', 'mcode-sbx', 'openai-api', 'anthropic-api', 'fal-api']);
const sup = Object.create(Supervisor.prototype) as Supervisor;
(sup as unknown as { d: { adapters: typeof adapters } }).d = { adapters };
const caps = (route: RouteConfig) => sup.routeCapabilities(route);

describe('what a route reports it can take', () => {
  it('says an API chat route sees images, with the default size cap', () => {
    const c = caps({ model: 'minimax/MiniMax-M3.1-Flash', adapter: 'anthropic-api', options: { baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M3.1-Flash' } });
    expect(c).toEqual({ attachments: ['text', 'image'], vision: true, embed: false, transcribe: false, maxImageMb: 10 });
    expect(describeCapabilities(c)).toBe('sees images');
  });

  it('reports the model and vector length of an embeddings route', () => {
    const c = caps({ model: 'cogitator/embed', adapter: 'openai-api', options: { baseUrl: 'http://127.0.0.1:1/v1', model: 'nomic-embed', mode: 'embeddings', dimensions: 768 } });
    expect(c).toMatchObject({ attachments: ['text'], vision: false, embed: true, embedding: { model: 'nomic-embed', dimensions: 768 } });
    expect(describeCapabilities(c)).toBe('embeds text');
  });

  it('leaves the vector length out when the route does not set it', () => {
    const c = caps({ model: 'cogitator/embed', adapter: 'openai-api', options: { baseUrl: 'http://127.0.0.1:1/v1', model: 'nomic-embed', mode: 'embeddings' } });
    expect(c.embedding).toEqual({ model: 'nomic-embed' });
  });

  it('reports a transcription route and the prompt limit a route sets', () => {
    const c = caps({ model: 'x/whisper', adapter: 'openai-api', options: { baseUrl: 'http://127.0.0.1:1/v1', model: 'w', mode: 'transcribe', maxAudioMb: 5, maxInput: 9000 } });
    expect(c).toMatchObject({ attachments: ['audio'], transcribe: true, maxAudioMb: 5, maxInput: 9000 });
    expect(describeCapabilities(c)).toBe('transcribes audio');
  });

  it('says a harness route takes only a text prompt, and an unknown adapter takes nothing', () => {
    expect(caps({ model: 'codex/sol', adapter: 'codex-exec' })).toEqual({ attachments: [], vision: false, embed: false, transcribe: false });
    expect(caps({ model: 'a/b', adapter: 'not-enabled' }).attachments).toEqual([]);
    expect(describeCapabilities(caps({ model: 'minimax/MiniMax-M3.1-Flash', adapter: 'mcode-sbx' }))).toBe('text prompts only');
  });
});
