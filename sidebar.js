import { askJev, getJevApiKey, setJevApiKey } from './jev.js';
import {
  PROVIDERS,
  modelsForProvider,
  fillToolArgsWithLLM,
  getLlmProvider,
  setLlmProvider,
  getLlmModel,
  setLlmModel,
  getLlmApiKey,
  setLlmApiKey,
} from './llm.js';
import { buildJevQuestions, interpretDecision, finalizeHybridDecision, columnFor } from './planning.js';
import { formatConfidence, formatCall, formatResult, normalizeResult, stableStringify } from './format.js';

const turns = document.getElementById('turns');
const jevLog = document.getElementById('jevLog');
const llmLog = document.getElementById('llmLog');
const composer = document.getElementById('composer');
const promptInput = document.getElementById('promptInput');
const sendBtn = document.getElementById('sendBtn');
const clearBtn = document.getElementById('clearBtn');
const settingsBtn = document.getElementById('settingsBtn');
const jevCountEl = document.getElementById('jevCount');
const llmCountEl = document.getElementById('llmCount');
const settingsDialog = document.getElementById('settingsDialog');
const jevKeyInput = document.getElementById('jevKeyInput');
const llmProviderSelect = document.getElementById('llmProviderSelect');
const llmModelSelect = document.getElementById('llmModelSelect');
const llmKeyInput = document.getElementById('llmKeyInput');
const llmKeyLabel = document.getElementById('llmKeyLabel');

let currentTools = [];
let inFlightController = null;
let jevToolCalls = 0;
let llmToolCalls = 0;
const MAX_TOOL_CALLS = 1000;
const MAX_IDENTICAL_OUTCOMES = 3;

init();

async function init() {
  updateColumnCounts();
  await refreshApiKeyIndicator();
  await refreshTools();

  // While a run is active, currentTools is pinned to that run's tab (see
  // handleUserMessage) — idle tab-switch tracking must not clobber it.
  chrome.tabs.onActivated.addListener(() => {
    if (!inFlightController) refreshTools();
  });
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.status === 'complete' && !inFlightController) refreshTools();
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'toolsChanged' && !inFlightController) refreshTools();
  });
}

// textContent throughout (no innerHTML) so this stays safe even if these
// lists ever stop being our own hardcoded constants.
function populateSelect(selectEl, items, getValue, getLabel) {
  selectEl.textContent = '';
  for (const item of items) {
    const option = document.createElement('option');
    option.value = getValue(item);
    option.textContent = getLabel(item);
    selectEl.appendChild(option);
  }
}

populateSelect(llmProviderSelect, PROVIDERS, (p) => p.id, (p) => p.label);

settingsBtn.onclick = async () => {
  jevKeyInput.value = await getJevApiKey();

  const providerId = await getLlmProvider();
  llmProviderSelect.value = providerId;
  await loadProviderFields(providerId);

  settingsDialog.showModal();
};

async function loadProviderFields(providerId) {
  const info = PROVIDERS.find((p) => p.id === providerId);
  llmKeyLabel.textContent = `${info.label} API key`;
  llmKeyInput.placeholder = info.keyPlaceholder;
  llmKeyInput.value = await getLlmApiKey(providerId);

  const models = modelsForProvider(providerId);
  populateSelect(llmModelSelect, models, (m) => m.id, (m) => m.label);
  llmModelSelect.value = await getLlmModel(providerId);
}

jevKeyInput.addEventListener('change', () => setJevApiKey(jevKeyInput.value.trim()));

llmProviderSelect.addEventListener('change', async () => {
  await setLlmProvider(llmProviderSelect.value);
  await loadProviderFields(llmProviderSelect.value);
});

llmModelSelect.addEventListener('change', () =>
  setLlmModel(llmProviderSelect.value, llmModelSelect.value),
);

llmKeyInput.addEventListener('change', () =>
  setLlmApiKey(llmProviderSelect.value, llmKeyInput.value.trim()),
);

settingsDialog.addEventListener('close', refreshApiKeyIndicator);

clearBtn.onclick = () => {
  if (inFlightController) inFlightController.abort();

  jevToolCalls = 0;
  llmToolCalls = 0;
  updateColumnCounts();

  turns.innerHTML = '';
  jevLog.innerHTML = '<p class="empty-state">No tool calls yet</p>';
  llmLog.innerHTML = '<p class="empty-state">No tool calls yet</p>';
  if (currentTools.length === 0) {
    renderEmptyState('No WebMCP tools found on this page yet.');
  }

  promptInput.focus();
};

function updateColumnCounts() {
  jevCountEl.textContent = `${jevToolCalls} tool call${jevToolCalls === 1 ? '' : 's'}`;
  llmCountEl.textContent = `${llmToolCalls} tool call${llmToolCalls === 1 ? '' : 's'}`;
}

async function refreshApiKeyIndicator() {
  const jevKey = await getJevApiKey();
  const providerId = await getLlmProvider();
  const llmKey = await getLlmApiKey(providerId);
  const providerLabel = PROVIDERS.find((p) => p.id === providerId)?.label || providerId;
  settingsBtn.classList.toggle('icon-btn--active', !!jevKey && !!llmKey);
  settingsBtn.title = `API keys - Jev: ${jevKey ? 'set' : 'missing'}, ${providerLabel}: ${llmKey ? 'set' : 'missing'}`;
}

// Pass an explicit `pinnedTab` to refresh a specific tab's tool list (used
// while a run is in progress) instead of whichever tab currently has focus.
async function refreshTools(pinnedTab) {
  const tab = pinnedTab ?? (await getActiveTab());
  if (!tab) return;

  const response = await sendToContentScript(tab.id, { action: 'LIST_TOOLS' });

  if (!response || response.error) {
    currentTools = [];
    renderEmptyState(response?.error || 'Could not reach this page.');
    return;
  }

  currentTools = response.tools || [];

  if (turns.querySelector('.empty-state')) {
    if (currentTools.length === 0) {
      renderEmptyState('No WebMCP tools found on this page yet.');
    } else {
      turns.innerHTML = '';
    }
  }
}

function renderEmptyState(text) {
  turns.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'empty-state';
  p.textContent = text;
  turns.appendChild(p);
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  if (inFlightController) {
    inFlightController.abort();
    return;
  }
  const message = promptInput.value.trim();
  if (!message) return;
  promptInput.value = '';
  autoGrow();
  handleUserMessage(message);
});

promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

promptInput.addEventListener('input', autoGrow);

function autoGrow() {
  promptInput.style.height = 'auto';
  promptInput.style.height = `${promptInput.scrollHeight}px`;
}

async function handleUserMessage(message) {
  addEntry('user', 'You', message);

  if (currentTools.length === 0) {
    addEntry('info', null, 'No WebMCP tools are available on this page.');
    return;
  }

  // Pin the run to whichever tab it started on. Re-querying "the active tab"
  // on every loop iteration would silently redirect tool calls to a
  // different page if the user switches tabs mid-run.
  const tab = await getActiveTab();
  if (!tab) {
    addEntry('error', 'Error', 'Could not find the active browser tab.');
    return;
  }

  setSending(true);
  inFlightController = new AbortController();
  const { signal } = inFlightController;

  try {
    const history = [];
    let previousOutcome = null;
    let identicalOutcomeCount = 0;

    for (let callCount = 0; callCount < MAX_TOOL_CALLS && !signal.aborted; callCount++) {
      if (currentTools.length === 0) {
        addEntry('error', 'Error', 'The page no longer exposes any WebMCP tools.');
        return;
      }

      const decision = await decideNextAction(message, tab, history, signal);
      const column = columnFor(decision.provider);
      addEntry('reasoning', 'Why', decision.reasoning, column, decision.note);

      if (decision.finished) {
        addEntry(
          'info',
          'Finished',
          `Finished after ${history.length} tool call${history.length === 1 ? '' : 's'} ` +
            `(confidence ${formatConfidence(decision.confidence)}).`,
          column,
        );
        return;
      }

      const { tool, args, provider } = decision;
      addEntry('call', null, formatCall(tool.name, args), column);

      if (provider === 'Jev') {
        jevToolCalls++;
      } else {
        llmToolCalls++;
      }
      updateColumnCounts();

      const execResult = await sendToContentScript(tab.id, {
        action: 'EXECUTE_TOOL',
        name: tool.name,
        args,
      });

      if (execResult?.error) {
        addEntry('error', 'Error', execResult.error, column);
        history.push({ provider, tool: tool.name, args, error: execResult.error });
      } else {
        addEntry('result', 'Result', formatResult(execResult?.result), column);
        history.push({
          provider,
          tool: tool.name,
          args,
          result: normalizeResult(execResult?.result),
        });
      }

      const latest = history.at(-1);
      const outcome = stableStringify({
        tool: latest.tool,
        args: latest.args,
        error: latest.error,
        result: latest.result,
      });
      identicalOutcomeCount = outcome === previousOutcome ? identicalOutcomeCount + 1 : 1;
      previousOutcome = outcome;

      if (identicalOutcomeCount >= MAX_IDENTICAL_OUTCOMES) {
        addEntry(
          'error',
          'Stopped',
          `The same unsuccessful or unchanged tool outcome occurred ${MAX_IDENTICAL_OUTCOMES} times in a row. ` +
            'The run was stopped to prevent an infinite loop.',
        );
        return;
      }

      // Actions can change the tools exposed by the page, so the next
      // decision should route over the current list, not a stale one -
      // refreshed for the pinned tab, not whichever tab is now active.
      await refreshTools(tab);
    }

    if (!signal.aborted) {
      addEntry('error', 'Error', `Stopped after reaching the ${MAX_TOOL_CALLS}-call safety limit.`);
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      addEntry('error', 'Error', error.message, error.column);
    }
  } finally {
    setSending(false);
    inFlightController = null;
  }
}

async function decideNextAction(objective, tab, history, signal) {
  const { questions, routeCriteria, argumentPlans } = buildJevQuestions(currentTools);

  let response;
  try {
    response = await askJev({
      state: {
        user_objective: objective,
        page_title: tab?.title || '',
        page_url: tab?.url || '',
        history,
      },
      questions,
      signal,
    });
  } catch (error) {
    error.column = 'jev';
    throw error;
  }

  const decision = interpretDecision({ response, tools: currentTools, routeCriteria, argumentPlans });
  if (!decision.needsLLM) return decision;

  let llmArgs, provider, model;
  try {
    ({ args: llmArgs, provider, model } = await fillToolArgsWithLLM({
      objective,
      history,
      tool: decision.narrowedTool,
      alreadyFilled: decision.jevArgs,
      signal,
    }));
  } catch (error) {
    error.column = 'llm';
    throw error;
  }

  return finalizeHybridDecision(decision, { llmArgs, provider, model });
}

function setSending(sending) {
  sendBtn.textContent = sending ? 'Stop' : 'Send';
  sendBtn.classList.toggle('composer__send--stop', sending);
}

const COLLAPSIBLE_KINDS = new Set(['result', 'reasoning', 'call']);

function addEntry(kind, label, body, column, note) {
  const target = column === 'jev' ? jevLog : column === 'llm' ? llmLog : turns;
  target.querySelector('.empty-state')?.remove();

  const entry = document.createElement('div');
  entry.className = `entry entry--${kind}`;
  if (label) {
    const labelEl = document.createElement('div');
    labelEl.className = 'entry__label';
    labelEl.textContent = label;
    entry.appendChild(labelEl);
  }
  const bodyEl = document.createElement('div');
  bodyEl.className = 'entry__body';
  bodyEl.textContent = body;
  if (COLLAPSIBLE_KINDS.has(kind)) {
    bodyEl.classList.add('entry__body--collapsible', 'entry__body--collapsed');
    bodyEl.tabIndex = 0;
    bodyEl.setAttribute('role', 'button');
    bodyEl.setAttribute('aria-expanded', 'false');
    bodyEl.title = 'Click to expand';
    const toggle = () => {
      const collapsed = bodyEl.classList.toggle('entry__body--collapsed');
      bodyEl.setAttribute('aria-expanded', String(!collapsed));
      bodyEl.title = collapsed ? 'Click to expand' : 'Click to collapse';
    };
    bodyEl.addEventListener('click', toggle);
    bodyEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
  }
  entry.appendChild(bodyEl);

  if (note) {
    const noteEl = document.createElement('div');
    noteEl.className = 'entry__note';
    noteEl.textContent = note;
    entry.appendChild(noteEl);
  }

  target.appendChild(entry);
  target.scrollTop = target.scrollHeight;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToContentScript(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch (error) {
    return { error: error.message };
  }
}
