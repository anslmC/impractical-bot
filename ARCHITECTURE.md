# Architecture

## Status and Scope

This is a provisional design baseline for an experimental project, not a fixed specification. Keep implementation incremental and minimal; update this document when implementation evidence or practical constraints justify a change. The initial version is intended to run as one local Node.js process and one bot instance. It does not require a server, database, dashboard, or plugin system.

## Proposed Flow

1. Playwright connects over CDP to an already-running Brave instance, using the dedicated profile planned at `%LOCALAPPDATA%\impractical-bot\brave-profile`. The existing experiments use `http://127.0.0.1:9222`.
2. The browser-interaction responsibility identifies and retains the intended Facebook Messages tab and conversation. It must not silently switch either.
3. The message-scanning responsibility reads rendered messages and determines sender and direction. If either is unknown, bot logic must not generate or send a response to that message.
4. Bot logic determines whether a response is appropriate and prepares input for generation.
5. AI integration requests a draft from the planned NVIDIA API. This integration does not exist yet.
6. Response validation and the approval/safety responsibility check the draft before sending. The exact validation rules and approval workflow remain undecided.
7. The sending responsibility interacts with the composer only for the verified conversation. If a send may have occurred but its outcome is uncertain, do not automatically retry.

These are logical responsibilities, not a commitment to separate modules or files. The implementation should follow the smallest structure that preserves the boundaries and safety rules.

## Safety Invariants

- Never automatically retry a send after an uncertain outcome; doing so could duplicate a message.
- Do not respond when sender or message direction is unknown.
- Do not silently switch browser tabs or conversations.
- Validate generated responses before sending; generation alone is not authorization to send.
- Keep the initial deployment to a single local bot instance.

## Milestones

The sequence below is a provisional plan. M1 is the next milestone; later milestone scope may be revised as the browser and Messenger behavior are verified.

- **M1 - Browser connection:** connect to the existing Brave instance through Playwright CDP.
- **M2 - Conversation identity:** identify the intended tab and conversation and detect unexpected changes.
- **M3 - Message scanning:** read rendered messages and classify sender and direction.
- **M4 - Bot logic:** decide when a response is appropriate and prepare generation context.
- **M5 - AI integration:** add NVIDIA API response generation.
- **M6 - Safety and sending:** validate generated text, apply approval/safety checks, and send through the verified composer.
- **M7 - End-to-end hardening:** exercise the integrated workflow and failure handling before expanding use.

## Existing Evidence

Local experiments in `Tools/test-backread.js` and `Tools/test-composer.js` attach to `127.0.0.1:9222`, look for an already-open Facebook Messages page, and inspect rendered message elements. The backread experiment collects message IDs, labels, and text with bounded scrolling. The composer experiment fills a draft and requires an explicit `SEND` confirmation before it attempts to click a uniquely matched, visible, enabled send control. These experiments are not production components; `Tools/` is currently ignored by Git.

## Limitations and Open Questions

- Messenger DOM selectors and accessible labels may change; the experiments only inspect currently rendered elements and do not establish complete history retrieval.
- Brave CDP startup, profile ownership, and behavior when Brave is unavailable or has multiple relevant tabs need to be established in M1.
- Reliable conversation identity, message completeness/order, and sender/direction classification need verification beyond the current experiments.
- NVIDIA API details, credentials handling, request limits, and failure behavior are not defined or implemented.
- Response validation criteria and the approval workflow are not defined. A successful click is not proof of message delivery.
- Setup, operation, recovery after uncertain sends, and production-level test strategy remain to be defined.
