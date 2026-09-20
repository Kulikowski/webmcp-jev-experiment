# WebMCP + Jev

> [!WARNING]
> This repository is an experiment for demonstration and educational purposes
> only. It is not a production-ready product or service, and its security and
> reliability controls are deliberately simplified.
>
> Do not use production API keys, personal information, or other sensitive data
> with this extension. Do not distribute or deploy it as a production tool
> without an appropriate security review and additional safeguards.

A small Chrome extension for trying [Jev](https://docs.typesafe.ai), a
structured-decision model, as the router for WebMCP tools. Chat in the side
panel; Jev picks a tool exposed by the current page and calls it.

## Setup

1. Chrome needs WebMCP's `document.modelContext` API, which is still
   experimental: launch it with the **"WebMCP for testing"** flag enabled
   (or the equivalent `chrome://flags` entry), on a build that supports it.
2. `chrome://extensions` → enable Developer Mode → **Load unpacked** → select
   this directory.
3. Open the side panel and hit the ⚙ button: set a Jev API key (from
   TypeSafe), then pick an LLM provider and model (Anthropic, Google, or
   OpenAI) and its API key. Everything is stored per-provider in
   `chrome.storage.local`, unencrypted - fine for a local prototype, not for
   shipping.
4. Open a page that registers WebMCP tools and ask for something in the chat.

## How it decides

A tool is **fully enumerable** when every parameter's possible values are
known in advance - an `enum`, a boolean, or a fixed list of options. Jev
can't generate free text, but it doesn't need to: for a fully enumerable
tool it picks the tool *and* every argument as typed choices.

1. Jev picks the next tool (or `__finish_task__`) and fills every enumerable
   argument, all in one request - Jev answers a batch of questions in
   parallel, so this costs nothing extra.
2. If the chosen tool also has free-text or numeric parameters, an LLM
   (whichever provider you configured) fills just those, told what Jev
   already decided so it doesn't redo that work.
3. The extension calls `document.modelContext.executeTool` and logs the
   call, why it was chosen, and its result - in the Jev or LLM column,
   depending on who supplied that step.
4. The result feeds back into Jev's state and the loop repeats until Jev
   picks `__finish_task__` (or a safety limit kicks in).

Everything happens client-side in the extension - no backend server.

## Known limits (by design, for v1)

- Single top-level frame only - no iframe/cross-document tools yet.
- Only one LLM provider is active at a time, and it's only called for
  arguments Jev can't represent.
- Repeating the same tool call and outcome three times stops the run, to
  avoid infinite loops.
- No conversation memory across turns beyond what's on screen.
- Trust boundary: a tool's name/description/schema comes from the page and
  is sent verbatim to both Jev and, for the LLM fallback, a third-party
  provider. A hostile page could target that with an adversarial tool
  description. This is inherent to the pattern, not something this
  prototype defends against.

## Code layout

The decision logic is pure and unit tested (`npm test`, Node's built-in
runner, no dependencies) independently of the DOM/network glue:

- `tools.js`, `format.js`, `planning.js` - schema classification, log
  formatting, and turning tools/responses into decisions. Fully tested.
- `jev.js`, `llm.js` - the Jev and LLM (Anthropic/Google/OpenAI) API clients.
- `content.js`, `background.js` - the WebMCP/extension glue.
- `sidebar.js` - DOM rendering and orchestration, wiring the above together;
  not unit tested (would need a full DOM rather than the plain mocks used
  everywhere else).

## License

Available under the [MIT License](LICENSE).
