/**
 * Multi-provider LLM fallback for tools whose required arguments cannot be
 * produced from Jev's enumerable primitives (free-text/numeric fields).
 * One forced single-tool-call request per provider - no conversation loop,
 * no streaming. Endpoint shapes and headers follow each provider's own
 * documented direct-browser API (validated against
 * https://github.com/Kulikowski/webmcp-ard-exploration/blob/main/src/agent-core.ts).
 */

export const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', keyPlaceholder: 'sk-ant-...' },
  { id: 'gemini', label: 'Google', keyPlaceholder: 'AIza...' },
  { id: 'openai', label: 'OpenAI', keyPlaceholder: 'sk-...' },
];

// Up to 3 of each provider's most popular current models, most capable first
// (first entry per provider doubles as that provider's default).
export const MODELS = [
  { id: 'claude-opus-5', provider: 'anthropic', label: 'Opus 5' },
  { id: 'claude-sonnet-5', provider: 'anthropic', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001', provider: 'anthropic', label: 'Haiku 4.5' },
  { id: 'gemini-3.1-pro-preview', provider: 'gemini', label: 'Gemini 3.1 Pro' },
  { id: 'gemini-3.6-flash', provider: 'gemini', label: 'Gemini 3.6 Flash' },
  { id: 'gemini-3.1-flash-lite', provider: 'gemini', label: 'Gemini 3.1 Flash Lite' },
  { id: 'gpt-5.6', provider: 'openai', label: 'GPT-5.6' },
  { id: 'gpt-5.6-luna', provider: 'openai', label: 'GPT-5.6 Luna' },
  { id: 'gpt-5.6-terra', provider: 'openai', label: 'GPT-5.6 Terra' },
];

const DEFAULT_PROVIDER = 'anthropic';

export function modelsForProvider(providerId) {
  return MODELS.filter((m) => m.provider === providerId);
}

export async function getLlmProvider() {
  const { llmProvider } = await chrome.storage.local.get('llmProvider');
  return PROVIDERS.some((p) => p.id === llmProvider) ? llmProvider : DEFAULT_PROVIDER;
}

export async function setLlmProvider(providerId) {
  await chrome.storage.local.set({ llmProvider: providerId });
}

export async function getLlmModel(providerId) {
  const allowed = modelsForProvider(providerId);
  const key = `llmModel_${providerId}`;
  const stored = await chrome.storage.local.get(key);
  return allowed.some((m) => m.id === stored[key]) ? stored[key] : allowed[0]?.id;
}

export async function setLlmModel(providerId, modelId) {
  await chrome.storage.local.set({ [`llmModel_${providerId}`]: modelId });
}

export async function getLlmApiKey(providerId) {
  const key = `llmApiKey_${providerId}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key] || '';
}

export async function setLlmApiKey(providerId, apiKey) {
  await chrome.storage.local.set({ [`llmApiKey_${providerId}`]: apiKey });
}

function providerInfo(providerId) {
  const info = PROVIDERS.find((p) => p.id === providerId);
  if (!info) throw new Error(`Unknown LLM provider "${providerId}".`);
  return info;
}

function buildPrompt(objective, history, alreadyFilled) {
  return JSON.stringify({
    task:
      'Fill the arguments for the selected WebMCP tool. Call the supplied function exactly once; do not answer with text. ' +
      'Use concrete values from the user objective and prior tool results. Optional free-text fields may be necessary, so ' +
      'do not omit them merely because the schema marks them optional. Never repeat arguments from an unsuccessful prior call. ' +
      'Some arguments for this same call were already decided separately (see already_filled_arguments below) - ' +
      'do not re-supply them; only fill the arguments in the function schema you were given.',
    user_objective: objective,
    chronological_tool_history: history,
    already_filled_arguments: alreadyFilled && Object.keys(alreadyFilled).length ? alreadyFilled : undefined,
  });
}

async function fetchOrThrow(url, init, providerLabel) {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(
      `Could not reach ${providerLabel} (${url}): ${error.message}. ` +
        'Check your network connection and any ad blocker/privacy extension that might block this domain.',
    );
  }
}

async function callAnthropic({ apiKey, model, prompt, tool, signal }) {
  const response = await fetchOrThrow(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Required for direct browser -> api.anthropic.com CORS access.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
        tool_choice: { type: 'tool', name: tool.name },
        tools: [
          {
            name: tool.name,
            description: tool.description || tool.name,
            input_schema: tool.inputSchema || { type: 'object', properties: {} },
          },
        ],
      }),
      signal,
    },
    'Anthropic',
  );

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Anthropic API error ${response.status}: ${json?.error?.message || response.statusText}`);
  }

  const toolUse = json?.content?.find((block) => block.type === 'tool_use');
  if (!toolUse) throw new Error(`Anthropic did not return a call for "${tool.name}".`);
  return toolUse.input ?? {};
}

async function callOpenAI({ apiKey, model, prompt, tool, signal }) {
  const response = await fetchOrThrow(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        tool_choice: { type: 'function', function: { name: tool.name } },
        tools: [
          {
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description || tool.name,
              parameters: tool.inputSchema || { type: 'object', properties: {} },
            },
          },
        ],
      }),
      signal,
    },
    'OpenAI',
  );

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`OpenAI API error ${response.status}: ${json?.error?.message || response.statusText}`);
  }

  const call = json?.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) throw new Error(`OpenAI did not return a call for "${tool.name}".`);
  try {
    return call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    throw new Error(`OpenAI returned unparsable arguments for "${tool.name}".`);
  }
}

async function callGemini({ apiKey, model, prompt, tool, signal }) {
  const properties = tool.inputSchema?.properties || {};
  const functionDeclaration = { name: tool.name, description: tool.description || tool.name };
  if (Object.keys(properties).length) functionDeclaration.parameters = tool.inputSchema;

  const response = await fetchOrThrow(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ functionDeclarations: [functionDeclaration] }],
        tool_config: {
          function_calling_config: { mode: 'ANY', allowed_function_names: [tool.name] },
        },
      }),
      signal,
    },
    'Google',
  );

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Google API error ${response.status}: ${json?.error?.message || response.statusText}`);
  }

  const part = json?.candidates?.[0]?.content?.parts?.find((p) => p.functionCall);
  if (!part) throw new Error(`Google did not return a call for "${tool.name}".`);
  return part.functionCall.args ?? {};
}

const ADAPTERS = { anthropic: callAnthropic, gemini: callGemini, openai: callOpenAI };

export async function fillToolArgsWithLLM({ objective, history, tool, alreadyFilled, signal }) {
  const providerId = await getLlmProvider();
  const info = providerInfo(providerId);
  const model = await getLlmModel(providerId);
  const apiKey = await getLlmApiKey(providerId);
  if (!apiKey) {
    throw new Error(
      `Tool "${tool.name}" needs free-text arguments. Set a ${info.label} API key in Settings first.`,
    );
  }

  const prompt = buildPrompt(objective, history, alreadyFilled);
  const args = await ADAPTERS[providerId]({ apiKey, model, prompt, tool, signal });
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`${info.label} returned invalid arguments for "${tool.name}".`);
  }
  const modelLabel = MODELS.find((m) => m.id === model)?.label || model;
  return { args, provider: info.label, model: modelLabel };
}
