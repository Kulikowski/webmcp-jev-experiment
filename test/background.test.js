import { test } from 'node:test';
import assert from 'node:assert/strict';

// background.js registers everything at import time, so each test installs
// its own chrome mock first and imports under a unique specifier (the query
// string) to force a fresh module evaluation instead of the cached one.
function mockChromeForBackground(tabs) {
  const calls = { setPanelBehavior: [], executeScript: [] };
  let onInstalledListener;
  const chrome = {
    sidePanel: {
      setPanelBehavior: (opts) => calls.setPanelBehavior.push(opts),
    },
    runtime: {
      onInstalled: {
        addListener: (fn) => {
          onInstalledListener = fn;
        },
      },
    },
    tabs: {
      query: async () => tabs,
    },
    scripting: {
      executeScript: async (opts) => {
        calls.executeScript.push(opts);
        if (opts.target.tabId === 'reject-me') throw new Error('no access');
      },
    },
  };
  return { chrome, calls, fireInstalled: () => onInstalledListener() };
}

test('background.js: enables click-to-open side panel behavior on load', async () => {
  const { chrome, calls } = mockChromeForBackground([]);
  globalThis.chrome = chrome;
  await import(`../background.js?case=panel-behavior`);
  assert.deepEqual(calls.setPanelBehavior, [{ openPanelOnActionClick: true }]);
});

test('background.js: onInstalled backfills content.js into every open tab that has an id', async () => {
  const tabs = [{ id: 1 }, { id: 2 }, { id: undefined }];
  const { chrome, calls, fireInstalled } = mockChromeForBackground(tabs);
  globalThis.chrome = chrome;
  await import(`../background.js?case=backfill`);

  await fireInstalled();
  await new Promise((resolve) => setTimeout(resolve, 0)); // flush the fire-and-forget executeScript calls

  assert.equal(calls.executeScript.length, 2);
  assert.deepEqual(calls.executeScript[0], { target: { tabId: 1 }, files: ['content.js'] });
  assert.deepEqual(calls.executeScript[1], { target: { tabId: 2 }, files: ['content.js'] });
});

test('background.js: a rejected executeScript call for one tab does not throw or block the others', async () => {
  const tabs = [{ id: 'reject-me' }, { id: 3 }];
  const { chrome, calls, fireInstalled } = mockChromeForBackground(tabs);
  globalThis.chrome = chrome;
  await import(`../background.js?case=partial-failure`);

  await assert.doesNotReject(() => fireInstalled());
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.executeScript.length, 2);
});
