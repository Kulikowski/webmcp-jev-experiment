/** Shared mocks for chrome.storage.local and fetch, used across test files. */

export function mockChromeStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    local: {
      async get(keys) {
        if (typeof keys === 'string') return { [keys]: store[keys] };
        if (Array.isArray(keys)) {
          const out = {};
          for (const key of keys) out[key] = store[key];
          return out;
        }
        return { ...store };
      },
      async set(values) {
        Object.assign(store, values);
      },
    },
  };
}

/** Returns a fetch mock that replies with each queued response in order.
 *  Each entry: { ok, status, statusText, json, text, throw }. */
export function mockFetchQueue(responses) {
  const queue = [...responses];
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error('mockFetchQueue: no more responses queued');
    if (next.throw) throw next.throw;
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      statusText: next.statusText ?? 'OK',
      json: async () => next.json ?? {},
      text: async () => next.text ?? JSON.stringify(next.json ?? {}),
    };
  };
  fetchMock.calls = calls;
  return fetchMock;
}
