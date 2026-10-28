# Architecture

## Status and Scope

The project is a local Node.js CLI, intended to run as one process and one bot instance. It needs no server, database, or plugin system. Production code already provides browser discovery and managed launch, configuration, NVIDIA key validation and reply generation, message backread, and a tested Messenger composer.

The current `start` path is a proven one-shot pipeline: validate the NVIDIA API key, launch and prepare the configured browser/conversation, read rendered messages, generate one reply, attempt to send it, then wait for shutdown. It is not yet the persistent conversation engine described below. Code under `Tools/` contains independent experiments and is not production behavior. This document marks the M2 target as planned unless explicitly identified as implemented/proven.

## Responsibilities

- **CLI (`src/cli.ts`, `bin/`):** route commands and coordinate startup, operation, and shutdown.
- **Configuration (`src/config/`):** load and validate local settings. Configuration, credentials, and runtime state belong outside the repository, under the user's local application-data directory.
- **Browser (`src/browser/`):** discover Brave, Google Chrome, or Microsoft Edge, prepare a dedicated profile, launch the selected browser with remote debugging bound to loopback, and connect Playwright through CDP. Firefox is out of scope.
- **Messages (`src/components/`):** read rendered messages and provide stable identity, sender, direction, and freshness information to the engine.
- **AI (`src/ai/`):** validate the NVIDIA API key and generate reply text from caller-provided context. It does not control browser actions, files, or secrets independently.
- **Conversation engine (M2 target):** coordinate observation, batching, participation decisions, generation, pre-send checks, and lifecycle without owning browser discovery.

Keep implementation incremental and reuse the existing tested composer. The engine remains one active generation/send operation at a time, while message observation continues during that operation.

## M2 Conversation Flow

The M2 target transitions from the proven one-shot pipeline to a persistent, decision-driven conversation engine:

1. **Initialization:** validate the NVIDIA API key; connect to the configured browser and conversation; handle startup challenges; establish an initial message-ID baseline; load recent messages; and load optional saved context and personality instructions. A startup baseline is context, not a reply trigger.
2. **Fresh-message observation:** poll a small recent-message window and deduplicate by stable message ID. A `MutationObserver` may wake the engine during idle periods, but it is only a wake-up mechanism; polling and stable-ID comparison determine freshness, and the observer does not classify messages or decide whether to reply.
3. **Batching:** collect fresh messages during a short quiet period and group related arrivals into one response opportunity.
4. **Smart decisions:** prioritize genuine reactive opportunities, such as direct mentions and clear requests. Evaluate proactive opportunities separately with local decision rules, cooldowns, and configurable talkativeness. Do not use historical messages as reply triggers.
5. **Generation:** send recent conversation context, applicable saved context, personality instructions, and other required instructions to NVIDIA. Temperature controls response variation, not participation frequency.
6. **Pre-send reassessment:** before sending, check for stop or pause requests, newer high-priority messages, stale or redundant replies, and a valid destination. Discard or regenerate a proposal that no longer fits the current conversation state.
7. **Composition and sending:** reuse the existing tested composer behavior. Track generation success, send attempts, and confirmed delivery as separate outcomes. A successful composer action is a send attempt, not proof of delivery.
8. **Continuous operation:** return to observation after every processing cycle. Observe incoming activity while generation or sending is active, but do not start a second generation/send operation concurrently.

## Lifecycle and Failure Behavior

These are agreed M2 behaviors; they are not all implemented in the current one-shot path.

- **Pause and resume:** continue observing while paused but suppress replies. On resume, reassess accumulated messages against the current conversation and decision rules rather than blindly replaying queued replies.
- **Destination switching:** suspend reply processing, discard pending work for the old destination, navigate to and verify the new destination, establish a fresh baseline, and resume only after verification. If switching fails, remain paused and allow retry.
- **Stop:** reject new work, suppress unsent replies, settle active work where practical without waiting indefinitely, clear pending work, gracefully close the bot-managed browser, release resources, and exit.
- **Browser or CDP failure:** stop the engine and report the failure; recovery requires another `start`.
- **Temporary DOM or message-area failure:** suspend processing and retry verification. Recovery must not add duplicate listeners or duplicate message entries.
- **NVIDIA failures:** use bounded retries and backoff for transient failures; do not blindly retry invalid requests. Retries must preserve a manual pause state.
- **Uncertain send outcome:** do not blindly resend. Record send attempts separately from confirmed delivery because a composer action alone cannot prove delivery.

## Personality and Saved Context

`personality.txt` is the optional, editable default personality configuration. If it is missing or empty, use a short built-in fallback; loading personality must not block startup. Personality governs conversational style, not whether the bot participates.

The configured bot temperament (`quiet`, `balanced`, or `talkative`) maps to RNG participation probabilities and is independent of personality. It is stored in `config.json` and can be changed with `setbottemp`; changing it updates a running engine without pausing, resuming, or restarting it.

Saved conversation context is a future extension. Until it exists, recent messages are sufficient for initial operation. Historical messages provide context only; they are not reply triggers.

## Safety Invariants

- Track ownership of the browser process launched by the application; never stop unrelated browser instances.
- Keep CDP bound to loopback and connect only to the managed browser.
- Do not silently change the active tab or destination; verify a destination switch before resuming replies.
- Do not make reply decisions from unknown or stale message identity, direction, or conversation state.
- Reassess proposals immediately before sending and discard stale or redundant work.
- Do not automatically resend after an uncertain send outcome.
- Keep credentials, recovery PINs, API keys, session data, and runtime state outside the repository.
- Keep AI generation separate from participation decisions and browser actions.

## Milestones

- **M0 — Foundation**
- **M1 — Browser + CLI Lifecycle ("Cranking")**
- **M2 — Ignition + Running:** transition from the proven one-shot pipeline to a persistent, decision-driven conversation engine.
- **M3 — Hardening & Polishing**

M2 development stages, in order, are **fresh-message detection**, **batching/decisions**, **continuous loop**, **lifecycle/recovery**, and **end-to-end testing**. These are work stages within M2, not official milestones.

## Implemented and Proven Boundaries

- Production startup validates the configured NVIDIA API key, launches the managed browser, prepares the configured conversation, and handles login and Messenger startup challenges.
- Production backread reads rendered messages and applies message identity and direction classification. It is bounded; it does not establish complete conversation history.
- Production generation uses recent messages to create a reply proposal. The current start path generates once from the backread rather than applying the planned continuous participation policy.
- The production composer checks that the composer and send control are usable before clicking. A click is reported as an attempt; delivery is not confirmed.
- Scripts in `Tools/` are exploratory, independent experiments. They can provide evidence for the specific behaviors they exercise but do not establish managed-startup or continuous-engine behavior.

The planned polling, observer wake-up, batching, participation policy, personality loading, saved context, pause/resume, destination-switch recovery, and bounded NVIDIA retry policy still require implementation and end-to-end verification. Messenger's rendered structure can change, so verification should exercise the production path and preserve the send-outcome distinction.
