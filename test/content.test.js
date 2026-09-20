import { test } from 'node:test';
import assert from 'node:assert/strict';

// content.js registers its message listener at import time and reads
// `window`/`document` directly, so each test sets those globals first and
// imports under a unique specifier (query string) to force a fresh module.
function mockEnvironment(modelContext) {
  let messageListener;
  globalThis.window = { location: { href: 'https://example.com/' } };
  globalThis.document = modelContext !== undefined ? { modelContext } : {};
  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => {
          messageListener = fn;
        },
      },
      sendMessage: async () => {},
    },
  };
  return {
    send: (message) => new Promise((resolve) => messageListener(message, {}, resolve)),
  };
}

test('content.js: replies with an explanatory error when document.modelContext is unavailable', async () => {
  const { send } = mockEnvironment(undefined);
  await import(`../content.js?case=no-modelcontext`);
  const reply = await send({ action: 'LIST_TOOLS' });
  assert.match(reply.error, /WebMCP for testing/);
});

test('content.js: LIST_TOOLS maps document.modelContext.getTools() into a plain tool list', async () => {
  const modelContext = {
    getTools: async () => [{ name: 'look', description: 'Look around', inputSchema: { type: 'object', properties: {} } }],
  };
  const { send } = mockEnvironment(modelContext);
  await import(`../content.js?case=list-tools`);
  const reply = await send({ action: 'LIST_TOOLS' });
  assert.deepEqual(reply.tools, [
    { name: 'look', description: 'Look around', inputSchema: { type: 'object', properties: {} } },
  ]);
});

test('content.js: LIST_TOOLS parses a JSON-string inputSchema', async () => {
  const modelContext = {
    getTools: async () => [{ name: 'look', description: '', inputSchema: '{"type":"object","properties":{}}' }],
  };
  const { send } = mockEnvironment(modelContext);
  await import(`../content.js?case=parse-schema`);
  const reply = await send({ action: 'LIST_TOOLS' });
  assert.deepEqual(reply.tools[0].inputSchema, { type: 'object', properties: {} });
});

test('content.js: EXECUTE_TOOL passes args through as a plain object, not a JSON string (regression)', async () => {
  const tool = { name: 'filter_search_results' };
  let receivedInput;
  const modelContext = {
    getTools: async () => [tool],
    executeTool: async (_t, input) => {
      receivedInput = input;
      return { success: true };
    },
  };
  const { send } = mockEnvironment(modelContext);
  await import(`../content.js?case=object-args`);
  const reply = await send({
    action: 'EXECUTE_TOOL',
    name: 'filter_search_results',
    args: { max_price: 100, amenities: ['pool'] },
  });
  assert.deepEqual(receivedInput, { max_price: 100, amenities: ['pool'] });
  assert.deepEqual(reply.result, { success: true });
});

test('content.js: EXECUTE_TOOL falls back to a JSON string only on a "Failed to parse input" rejection', async () => {
  const tool = { name: 'move' };
  const seenInputs = [];
  const modelContext = {
    getTools: async () => [tool],
    executeTool: async (_t, input) => {
      seenInputs.push(input);
      if (typeof input !== 'string') throw new Error('Failed to parse input: expected string');
      return { success: true };
    },
  };
  const { send } = mockEnvironment(modelContext);
  await import(`../content.js?case=parse-fallback`);
  const reply = await send({ action: 'EXECUTE_TOOL', name: 'move', args: { direction: 'north' } });
  assert.deepEqual(seenInputs[0], { direction: 'north' });
  assert.equal(seenInputs[1], '{"direction":"north"}');
  assert.deepEqual(reply.result, { success: true });
});

test('content.js: EXECUTE_TOOL surfaces an unrelated error without retrying as a string', async () => {
  const tool = { name: 'move' };
  let calls = 0;
  const modelContext = {
    getTools: async () => [tool],
    executeTool: async () => {
      calls++;
      throw new Error('boom');
    },
  };
  const { send } = mockEnvironment(modelContext);
  await import(`../content.js?case=unrelated-error`);
  const reply = await send({ action: 'EXECUTE_TOOL', name: 'move', args: {} });
  assert.equal(reply.error, 'boom');
  assert.equal(calls, 1);
});

test('content.js: EXECUTE_TOOL reports a missing tool without touching document.modelContext.executeTool', async () => {
  let executeCalled = false;
  const modelContext = {
    getTools: async () => [],
    executeTool: async () => {
      executeCalled = true;
    },
  };
  const { send } = mockEnvironment(modelContext);
  await import(`../content.js?case=missing-tool`);
  const reply = await send({ action: 'EXECUTE_TOOL', name: 'gone', args: {} });
  assert.match(reply.error, /no longer available/);
  assert.equal(executeCalled, false);
});
