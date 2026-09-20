/**
 * Opens the side panel from the toolbar icon, and backfills the content
 * script into tabs that were already open before the extension loaded
 * (manifest content_scripts only attach to future navigations).
 */

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  for (const { id: tabId } of tabs) {
    if (tabId === undefined) continue;
    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
  }
});
