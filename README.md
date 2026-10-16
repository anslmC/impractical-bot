# impractical-bot

An experimental, local AI-powered Facebook Messenger bot project. The goal is to explore a bot that reads the active conversation, uses AI to prepare a response, and sends it through the existing Messenger session with safety checks.

## Current Status

The project is between repository setup and production implementation. Two local proof-of-concept scripts under `Tools/` demonstrate reading rendered messages and preparing a composer draft, with an explicitly authorized send path in the composer experiment. These are experiments, not a production bot. `Tools/` is currently ignored by Git.

The next planned milestone is **M1: connect to an existing Brave session through Playwright CDP**. The architecture and milestone sequence are provisional and may change when implementation evidence or practical constraints warrant it.

## Intended Operation

A single local Node.js process is intended to connect Playwright to an already-running Brave instance, identify the active Facebook Messages conversation, scan and classify its messages, and pass relevant context to bot logic. The bot logic is intended to request a response from NVIDIA's API, validate it, and pass it through a safety/approval step before sending it in the same conversation. Browser or conversation changes should be explicit, and uncertain sends must not be retried automatically.

Only the initial browser/message/composer experiments exist today. NVIDIA integration, production scanning and bot logic, validation, and a production sending workflow are not implemented.

## Technology

- Node.js; the project does not currently declare a Node.js engine range.
- Playwright, declared as `^1.64.1` and locked to `1.64.1` in the current lockfile.
- An existing Brave browser session exposed through CDP at `127.0.0.1:9222` in the experiments.
- Dedicated Brave profile planned at `%LOCALAPPDATA%\impractical-bot\brave-profile`.
- NVIDIA API planned for AI response generation; not integrated yet.

## Planned Milestones

This is an initial, changeable sequence; details beyond M1 remain to be confirmed during implementation.

1. **M1 - Browser connection:** connect to the existing Brave session through CDP.
2. **M2 - Conversation identity:** identify the intended Messenger tab and conversation without silently switching.
3. **M3 - Message scanning:** read and classify rendered messages; do not act on unknown sender or direction.
4. **M4 - Bot logic:** define when a response is appropriate and prepare the context for generation.
5. **M5 - AI integration:** connect response generation to the planned NVIDIA API.
6. **M6 - Safety and sending:** validate generated text, apply the approval/safety gate, and send only through the verified conversation.
7. **M7 - End-to-end hardening:** verify the complete workflow and its failure handling before considering broader use.

Setup and usage instructions are not finalized. Do not treat this document as instructions for operating a production bot.
