/**
 * Minimal client for Jev's systemOne endpoint, called directly from the
 * extension (no separate backend). https://docs.typesafe.ai/api
 */

const JEV_API_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';

export async function getJevApiKey() {
  const { jevApiKey } = await chrome.storage.local.get('jevApiKey');
  return jevApiKey || '';
}

export async function setJevApiKey(key) {
  await chrome.storage.local.set({ jevApiKey: key });
}

function serializeState(state) {
  if (typeof state === 'string') return state;

  const serialized = JSON.stringify(state);
  if (serialized === undefined) {
    throw new TypeError('Jev state must be a string or JSON-serializable value.');
  }
  return serialized;
}

export async function askJev({ state, questions, signal }) {
  const apiKey = await getJevApiKey();
  if (!apiKey) throw new Error('Set a Jev API key first (gear icon, top right).');

  let response;
  try {
    response = await fetch(JEV_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      // The API previously accepted structured JSON here, but some deployments
      // now reject object-valued state while parsing request parameters. Keep the
      // useful field names while sending the state through the stable string path.
      body: JSON.stringify({ model: JEV_MODEL, state: serializeState(state), questions }),
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(
      `Could not reach Jev (${JEV_API_URL}): ${error.message}. ` +
        'Check your network connection and any ad blocker/privacy extension that might block this domain.',
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Jev API error ${response.status}: ${text || response.statusText}`);
  }

  return response.json();
}
