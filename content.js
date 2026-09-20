/**
 * Bridges the sidebar to the page's WebMCP tools via `document.modelContext`.
 * Single top-level frame only for this prototype (no iframe/cross-document
 * tool support yet).
 */

console.debug(`[jev-tool-caller] ready on ${window.location.href}`);

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  const { action, name, args } = message;

  if (!document.modelContext) {
    reply({
      error: 'No WebMCP tools API on this page. Chrome needs to be run with the "WebMCP for testing" flag enabled.',
    });
    return;
  }

  if (action === 'LIST_TOOLS') {
    listTools().then(reply);
    document.modelContext.ontoolchange = () => {
      chrome.runtime.sendMessage({ type: 'toolsChanged' }).catch(() => {});
    };
    return true;
  }

  if (action === 'EXECUTE_TOOL') {
    executeTool(name, args).then(reply);
    return true;
  }
});

async function listTools() {
  try {
    const tools = await document.modelContext.getTools();
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: normalizeSchema(tool.inputSchema),
      })),
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function executeTool(name, args) {
  try {
    const tools = await document.modelContext.getTools();
    const tool = tools.find((t) => t.name === name);
    if (!tool) return { error: `Tool "${name}" is no longer available on this page.` };
    // Tools receive a plain object (e.g. `execute(input) { input.max_price }`).
    // Only fall back to a JSON string for older Chrome builds that reject an
    // object argument outright.
    let result;
    try {
      result = await document.modelContext.executeTool(tool, args ?? {});
    } catch (e) {
      if (e.message?.startsWith('Failed to parse input')) {
        result = await document.modelContext.executeTool(tool, JSON.stringify(args ?? {}));
      } else {
        throw e;
      }
    }
    return { result };
  } catch (e) {
    return { error: e.message };
  }
}

function normalizeSchema(inputSchema) {
  if (!inputSchema) return { type: 'object', properties: {} };
  return typeof inputSchema === 'string' ? JSON.parse(inputSchema) : inputSchema;
}
