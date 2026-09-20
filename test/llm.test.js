import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockChromeStorage, mockFetchQueue } from './helpers.js';
import {
  PROVIDERS,
  MODELS,
  modelsForProvider,
  getLlmProvider,
  setLlmProvider,
  getLlmModel,
  setLlmModel,
  getLlmApiKey,
  setLlmApiKey,
  fillToolArgsWithLLM,
} from '../llm.js';

test('PROVIDERS/MODELS: every provider has at least one model, every model belongs to a real provider', () => {
  for (const p of PROVIDERS) {
    assert.ok(modelsForProvider(p.id).length > 0, `${p.id} has no models`);
  }
  for (const m of MODELS) {
    assert.ok(PROVIDERS.some((p) => p.id === m.provider), `model ${m.id} has an unknown provider`);
  }
});

test('getLlmProvider: defaults to anthropic when nothing, or something invalid, is stored', async () => {
  globalThis.chrome = { storage: mockChromeStorage() };
  assert.equal(await getLlmProvider(), 'anthropic');

  globalThis.chrome = { storage: mockChromeStorage({ llmProvider: 'not-a-real-provider' }) };
  assert.equal(await getLlmProvider(), 'anthropic');
});

test('setLlmProvider/getLlmProvider: round-trip', async () => {
  globalThis.chrome = { storage: mockChromeStorage() };
  await setLlmProvider('openai');
  assert.equal(await getLlmProvider(), 'openai');
});

test('getLlmModel: defaults to the flagship model, and rejects a model id from a different provider', async () => {
  globalThis.chrome = { storage: mockChromeStorage() };
  assert.equal(await getLlmModel('anthropic'), modelsForProvider('anthropic')[0].id);

  await setLlmModel('anthropic', 'gpt-5.6'); // an OpenAI model id, invalid for Anthropic
  assert.equal(await getLlmModel('anthropic'), modelsForProvider('anthropic')[0].id);

  await setLlmModel('anthropic', 'claude-haiku-4-5-20251001');
  assert.equal(await getLlmModel('anthropic'), 'claude-haiku-4-5-20251001');
});

test('getLlmApiKey/setLlmApiKey: keys are stored per provider, independently', async () => {
  globalThis.chrome = { storage: mockChromeStorage() };
  await setLlmApiKey('anthropic', 'sk-ant-1');
  await setLlmApiKey('openai', 'sk-oai-1');
  assert.equal(await getLlmApiKey('anthropic'), 'sk-ant-1');
  assert.equal(await getLlmApiKey('openai'), 'sk-oai-1');
  assert.equal(await getLlmApiKey('gemini'), '');
});

test('fillToolArgsWithLLM: throws before calling fetch when no key is set for the selected provider', async () => {
  globalThis.chrome = { storage: mockChromeStorage({ llmProvider: 'anthropic' }) };
  let called = false;
  globalThis.fetch = async () => {
    called = true;
  };
  const tool = { name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } };
  await assert.rejects(
    () => fillToolArgsWithLLM({ objective: 'find x', history: [], tool }),
    /needs free-text arguments.*Anthropic API key/s,
  );
  assert.equal(called, false);
});

test('fillToolArgsWithLLM: Anthropic - forces the named tool and parses the tool_use block', async () => {
  globalThis.chrome = {
    storage: mockChromeStorage({ llmProvider: 'anthropic', llmApiKey_anthropic: 'sk-ant-1' }),
  };
  const fetchMock = mockFetchQueue([
    { json: { content: [{ type: 'tool_use', name: 'search', input: { query: 'hotels' } }] } },
  ]);
  globalThis.fetch = fetchMock;

  const tool = {
    name: 'search',
    description: 'Search',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  };
  const { args, provider, model } = await fillToolArgsWithLLM({
    objective: 'find hotels',
    history: [],
    tool,
    alreadyFilled: { amenities: ['pool'] },
  });

  assert.deepEqual(args, { query: 'hotels' });
  assert.equal(provider, 'Anthropic');
  assert.equal(model, modelsForProvider('anthropic')[0].label);

  const [{ url, init }] = fetchMock.calls;
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['x-api-key'], 'sk-ant-1');
  assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');

  const body = JSON.parse(init.body);
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'search' });
  assert.equal(body.tools[0].name, 'search');
  const prompt = JSON.parse(body.messages[0].content);
  assert.deepEqual(prompt.already_filled_arguments, { amenities: ['pool'] });
});

test('fillToolArgsWithLLM: Anthropic - throws when no tool_use block comes back', async () => {
  globalThis.chrome = {
    storage: mockChromeStorage({ llmProvider: 'anthropic', llmApiKey_anthropic: 'sk-ant-1' }),
  };
  globalThis.fetch = mockFetchQueue([{ json: { content: [{ type: 'text', text: 'sorry, no' }] } }]);
  const tool = { name: 'search', inputSchema: { type: 'object', properties: {} } };
  await assert.rejects(() => fillToolArgsWithLLM({ objective: 'x', history: [], tool }), /did not return a call/);
});

test('fillToolArgsWithLLM: OpenAI - forces the named function and parses its JSON arguments', async () => {
  globalThis.chrome = { storage: mockChromeStorage({ llmProvider: 'openai', llmApiKey_openai: 'sk-oai-1' }) };
  const fetchMock = mockFetchQueue([
    {
      json: {
        choices: [{ message: { tool_calls: [{ function: { name: 'search', arguments: '{"query":"hotels"}' } }] } }],
      },
    },
  ]);
  globalThis.fetch = fetchMock;

  const tool = { name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } };
  const { args, provider } = await fillToolArgsWithLLM({ objective: 'x', history: [], tool });
  assert.deepEqual(args, { query: 'hotels' });
  assert.equal(provider, 'OpenAI');

  const [{ url, init }] = fetchMock.calls;
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(init.headers.authorization, 'Bearer sk-oai-1');
  const body = JSON.parse(init.body);
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'search' } });
});

test('fillToolArgsWithLLM: OpenAI - throws on unparsable arguments instead of returning garbage', async () => {
  globalThis.chrome = { storage: mockChromeStorage({ llmProvider: 'openai', llmApiKey_openai: 'sk-oai-1' }) };
  globalThis.fetch = mockFetchQueue([
    { json: { choices: [{ message: { tool_calls: [{ function: { name: 'search', arguments: '{not json' } }] } }] } },
  ]);
  const tool = { name: 'search', inputSchema: { type: 'object', properties: {} } };
  await assert.rejects(() => fillToolArgsWithLLM({ objective: 'x', history: [], tool }), /unparsable arguments/);
});

test('fillToolArgsWithLLM: Gemini - forces the named function via ANY mode and reads functionCall.args', async () => {
  globalThis.chrome = { storage: mockChromeStorage({ llmProvider: 'gemini', llmApiKey_gemini: 'AIza1' }) };
  const fetchMock = mockFetchQueue([
    { json: { candidates: [{ content: { parts: [{ functionCall: { name: 'search', args: { query: 'hotels' } } }] } }] } },
  ]);
  globalThis.fetch = fetchMock;

  const tool = { name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } };
  const { args, provider } = await fillToolArgsWithLLM({ objective: 'x', history: [], tool });
  assert.deepEqual(args, { query: 'hotels' });
  assert.equal(provider, 'Google');

  const [{ url, init }] = fetchMock.calls;
  assert.match(url, /generativelanguage\.googleapis\.com\/v1beta\/models\/.+:generateContent/);
  assert.equal(init.headers['x-goog-api-key'], 'AIza1');
  const body = JSON.parse(init.body);
  assert.deepEqual(body.tool_config.function_calling_config, {
    mode: 'ANY',
    allowed_function_names: ['search'],
  });
});

test('fillToolArgsWithLLM: a network failure is wrapped with the provider name and endpoint', async () => {
  globalThis.chrome = {
    storage: mockChromeStorage({ llmProvider: 'anthropic', llmApiKey_anthropic: 'sk-ant-1' }),
  };
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  const tool = { name: 'search', inputSchema: { type: 'object', properties: {} } };
  await assert.rejects(() => fillToolArgsWithLLM({ objective: 'x', history: [], tool }), /Could not reach Anthropic/);
});
