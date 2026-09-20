import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockChromeStorage, mockFetchQueue } from './helpers.js';
import { getJevApiKey, setJevApiKey, askJev } from '../jev.js';

test('getJevApiKey/setJevApiKey: round-trips through chrome.storage.local', async () => {
  globalThis.chrome = { storage: mockChromeStorage() };
  assert.equal(await getJevApiKey(), '');
  await setJevApiKey('sk-jev-123');
  assert.equal(await getJevApiKey(), 'sk-jev-123');
});

test('askJev: throws before ever calling fetch when no key is configured', async () => {
  globalThis.chrome = { storage: mockChromeStorage() };
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
  };
  await assert.rejects(() => askJev({ state: 'hi', questions: {} }), /Set a Jev API key first/);
  assert.equal(fetchCalled, false);
});

test('askJev: posts to the systemone endpoint with the Bearer key and serialized state', async () => {
  globalThis.chrome = { storage: mockChromeStorage({ jevApiKey: 'sk-jev-123' }) };
  const fetchMock = mockFetchQueue([
    { json: { answers: { route: { choice: 'look', confidence: 0.9, probabilities: {} } } } },
  ]);
  globalThis.fetch = fetchMock;

  const result = await askJev({
    state: { user_objective: 'look around' },
    questions: { route: { type: 'choice' } },
  });

  assert.equal(fetchMock.calls.length, 1);
  const [{ url, init }] = fetchMock.calls;
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(init.headers.Authorization, 'Bearer sk-jev-123');

  const body = JSON.parse(init.body);
  assert.equal(body.model, 'jev-latest');
  assert.equal(typeof body.state, 'string'); // state always goes over the wire as a string
  assert.deepEqual(JSON.parse(body.state), { user_objective: 'look around' });
  assert.deepEqual(body.questions, { route: { type: 'choice' } });

  assert.deepEqual(result.answers.route, { choice: 'look', confidence: 0.9, probabilities: {} });
});

test('askJev: a string state is sent through as-is, not double-encoded', async () => {
  globalThis.chrome = { storage: mockChromeStorage({ jevApiKey: 'sk-jev-123' }) };
  const fetchMock = mockFetchQueue([{ json: { answers: {} } }]);
  globalThis.fetch = fetchMock;

  await askJev({ state: 'already a string', questions: {} });

  const body = JSON.parse(fetchMock.calls[0].init.body);
  assert.equal(body.state, 'already a string');
});

test('askJev: a non-ok HTTP response throws with the status and body text', async () => {
  globalThis.chrome = { storage: mockChromeStorage({ jevApiKey: 'sk-jev-123' }) };
  globalThis.fetch = mockFetchQueue([{ ok: false, status: 403, text: 'no key' }]);
  await assert.rejects(() => askJev({ state: 'hi', questions: {} }), /Jev API error 403: no key/);
});

test('askJev: a network-level fetch failure is wrapped with context, not left as a bare TypeError', async () => {
  globalThis.chrome = { storage: mockChromeStorage({ jevApiKey: 'sk-jev-123' }) };
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(
    () => askJev({ state: 'hi', questions: {} }),
    /Could not reach Jev.*Failed to fetch/s,
  );
});

test('askJev: an AbortError passes through unwrapped', async () => {
  globalThis.chrome = { storage: mockChromeStorage({ jevApiKey: 'sk-jev-123' }) };
  globalThis.fetch = async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };
  await assert.rejects(() => askJev({ state: 'hi', questions: {} }), (error) => error.name === 'AbortError');
});
