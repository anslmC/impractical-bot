# Architecture

## Status and Scope

This document describes intended architecture, not implemented behavior. M0 establishes the Node.js and TypeScript development foundation. The repository does not yet implement CLI commands, browser discovery or lifecycle management, configuration persistence, bot orchestration, message automation, or AI integration.

The application is intended to be a local Node.js CLI, initially running as one local process and one bot instance. It does not require a server, database, or plugin system. A terminal status dashboard may be added for bot operation.

## Intended Responsibilities

- **CLI (`src/cli/`, `bin/`):** route commands and present terminal interaction; it does not own browser discovery or bot policy.
- **Configuration (`src/config/`):** load and validate local settings. Configuration, credentials, and runtime state belong outside the repository, under the user's local application-data directory.
- **Browser (`src/browser/`):** discover Brave, Google Chrome, or Microsoft Edge, prepare a dedicated profile, launch the selected browser with remote debugging bound to loopback, and connect Playwright through that CDP endpoint. Firefox is out of scope.
- **Bot (`src/bot/`):** coordinate bot lifecycle and the message/AI workflow without taking ownership of browser-discovery details.
- **Messages (`src/messages/`):** identify the intended conversation, gather rendered messages, and apply message identity and freshness checks.
- **AI (`src/ai/`):** eventually request a response draft from an AI service. This component must not independently access browser controls, files, or secrets; access to necessary data must be mediated by its caller.

These are responsibility boundaries, not a commitment to speculative modules or extra processes. Keep implementation incremental and minimal.

## Intended Command Flow

1. `impbot init` will discover a supported browser, prepare its dedicated profile and runtime environment, launch it with the appropriate loopback debugging configuration, then automatically open the terminal configuration menu.
2. `impbot config` will open the same menu on demand, stopping the active bot first when necessary.
3. `impbot start` will provide the manual bot-start command and eventually establish a terminal status dashboard.
4. `impbot stop` will stop the bot and the browser process launched and managed by this application. It must not terminate unrelated browser instances.
5. The browser responsibility will connect Playwright to the managed browser through its loopback-only CDP endpoint. It will retain the intended tab and conversation and will not silently switch either.
6. Message handling will only provide context when message identity and direction are sufficiently known. AI generation, when added, will produce a proposal; it will not authorize sending.
7. A separate validation and approval step must precede sending. If a send may have occurred but the outcome is uncertain, the application must not retry automatically.

## Safety Invariants

- Track ownership of the browser process launched by the application; never stop unrelated browser instances.
- Keep CDP bound to loopback and connect only to the managed browser.
- Do not silently switch browser tabs or conversations.
- Do not act on messages with unknown sender, direction, or conversation identity.
- Discard or revalidate stale proposals when the conversation or relevant message context changes.
- Require validation and approval before sending; AI output alone is not authorization.
- Never automatically retry a send after an uncertain outcome, to avoid duplicate messages.
- Keep credentials, recovery PINs, API keys, session data, and runtime state outside the repository.
- The AI component must not independently access browser controls, files, or secrets.

## Milestones

- **M0 - Project foundation:** establish TypeScript, linting, Node's built-in test runner, repository structure, and accurate project documentation.
- **M1 - Browser and CLI lifecycle:** implement supported-browser discovery and managed launch, local configuration foundations, and the `init`, `config`, `start`, and `stop` command flows with process ownership safeguards.
- **M2 - Core Bot:** implement Playwright browser actions for navigation, retrieving and backreading messages, and sending messages; integrate NVIDIA AI response generation; and define system instructions governing the bot's behavior.
- **M3 - End-to-end hardening:** integrate and polish the workflow, improve reliability, and verify failure handling before expanding use.

## Existing Experiments and Open Questions

The JavaScript scripts in `Tools/` are independent experiments, not production components. They connect to an already-running browser at `127.0.0.1:9222`; navigation, PIN entry, composer, and bounded backread experiments provide limited source-level examples. They do not verify managed browser startup, process ownership, complete history retrieval, or production behavior.

- Messenger selectors and accessible labels may change. Conversation identity, message completeness and ordering, sender/direction classification, approval criteria, and recovery after uncertain sends require implementation and verification.
- Browser installation discovery, dedicated-profile behavior, browser-process ownership, and recovery when a supported browser is unavailable remain to be implemented and verified.
- NVIDIA API details, credential handling, request limits, and failure behavior are not defined or implemented. Dynamic message gathering and AI response generation remain future work.
- A successful send-control click is not proof of message delivery. Setup, operation, and production-level failure testing remain to be defined.
