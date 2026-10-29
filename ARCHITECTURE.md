# Architecture

## Status and Scope

The project is a local Node.js CLI, intended to run as one process and one bot instance. It needs no server, database, or plugin system. Production code provides browser discovery and managed launch, configuration, NVIDIA key validation and reply generation, message backread, the persistent M2 conversation engine ("Combustion"), and a tested Messenger composer.

The M2 engine is implemented: initialization seeds historical context, runtime polling observes new messages, explicitly incoming mentions open response packets, a FIFO scheduler runs one generation/send at a time, and a temperament-driven RNG path participates without a mention. Live end-to-end behavior in a real Messenger conversation still requires smoke verification. Code under `Tools/` contains independent experiments and is not production behavior.

Not implemented: bounded NVIDIA retries/backoff, saved or persistent conversation context (recent messages plus Backread are the whole context), and pre-send content reassessment beyond pause and destination checks.

## Responsibilities

- **CLI (`src/cli.ts`, `bin/`):** route commands and coordinate startup, operation, and shutdown.
- **Configuration (`src/config/`):** load and validate local settings. Configuration, credentials, and runtime state belong outside the repository, under the user's local application-data directory.
- **Browser (`src/browser/`):** discover Brave, Google Chrome, or Microsoft Edge, prepare a dedicated profile, launch the selected browser with remote debugging bound to loopback, and connect Playwright through CDP. Firefox is out of scope.
- **Messages (`src/components/backread.ts`, `src/components/message-extraction.ts`):** read rendered messages and provide stable identity, sender, direction, and freshness information.
- **Context Store (`src/components/context-store.ts`):** retain observed messages in observation order with stable-ID deduplication and bounded capacity.
- **Conversation engine (`src/components/combustion.ts` and its collaborators):** coordinate observation, mention-triggered packet building, FIFO scheduling, generation, pre-send checks, and lifecycle without owning browser discovery.
- **AI (`src/ai/nvidia.ts`):** validate the NVIDIA API key and generate reply text from caller-provided context. It does not control browser actions, files, or secrets independently.

The engine keeps one active generation/send operation at a time; message observation continues during that operation.

## M2 Running Pipeline

1. **Initialization (`impbot start`):** validate the configured NVIDIA API key; launch and prepare the configured browser and conversation; handle login and Messenger startup challenges; retrieve the puppet account name from the Messenger profile and persist it; initialize the Alias Engine from that name; run Backread over rendered history (up to 30 messages) and seed the Context Store with it; record the rendered message-ID baseline; start Combustion. Backread runs only during initialization; there is no runtime Backread.
2. **Runtime observation:** poll the rendered conversation every 3 seconds over a bounded window (the newest 20 rendered messages). Freshness is decided by stable `data-message-id` comparison against the IDs already seen, so re-reading a message is not new work. When no genuinely new message has appeared for 120 seconds the engine goes idle and arms a `MutationObserver` wake-up; the observer only signals possible activity and never classifies messages or decides whether to reply.
3. **Trigger eligibility:** a message may open a mention packet only when Messenger reported it as `INCOMING` and the alias match flagged it as a mention. `OUTGOING` and `UNKNOWN` messages never trigger a reply, even when their text contains one of the bot's aliases. Direction comes from the extracted `aria-label` sender (`You` means outgoing); a label that cannot be parsed stays `UNKNOWN`. The direction check lives at the packet-creation boundary, independently of how the mention flag was computed.
4. **Packet building (`src/components/mention-packet-builder.ts`):** a qualifying mention opens a packet (sequential `packet-NNN` ID) and holds it until the next poll. Messages observed while a packet is open are appended to it, so a short burst becomes one response opportunity. On finalization the packet carries `newMessages` (all fresh messages), `mentionMessages` (the qualifying incoming triggers), and `contextMessages` (conversation preceding the trigger). Context is the newest 20 Context Store messages plus the rendered window, deduplicated by message ID; anything that is already in `newMessages` is removed, so the current trigger is never sent twice.
5. **Scheduling (`src/components/packet-scheduler.ts`):** finalized packets are submitted to a FIFO queue that processes one packet at a time and rejects a packet ID it has already accepted. Pause holds queued packets; destination changes discard queued work; stop cancels it. Completed and failed packet IDs are recorded, and a failed packet is not retried.
6. **Generation (`src/ai/nvidia.ts`):** the request is a single system message followed by one API turn per Messenger message: incoming messages become `user` turns prefixed with their sender, outgoing messages become `assistant` turns (the bot's own posts), and `UNKNOWN` messages are dropped. The request is truncated after the latest incoming message so it always ends with the message being answered and never repeats it. Of the bot's own earlier posts, only the newest three assistant turns are sent; every incoming message is kept, so a long run of previous self-replies cannot make the model continue an obsolete argument instead of answering the latest message. Replies are capped at 256 tokens with thinking disabled and a 50-second timeout.
7. **Composition and sending (`src/components/composer.ts`):** verify the composer region and send control are unambiguous, visible, and enabled; enter the text; run the pre-send gate (pause state and destination epoch); click the send control exactly once. A click is a send attempt, not confirmed delivery, and an uncertain outcome is never resent automatically.
8. **Continuous operation:** return to observation after every cycle. A poll with no new messages changes nothing; the engine never replays a turn it has already answered.

## Context Store and Model Context

The Context Store retains observed messages in observation order, deduplicates them by stable message ID, clones stored messages, and evicts oldest first at a capacity of 60. It is seeded once by Backread and appended by runtime polls; runtime polling never re-runs Backread.

Messenger can render one logical message under two `data-message-id` namespaces (a numeric id and a `mid.$...` id); live evidence showed a single reply retained twice under both. The message readers reconcile such a pair into one record before the store, packet builder or request ever sees it (`src/components/message-identity.ts`). Reconciliation is deliberately narrow: the records must be adjacent in rendered order, share sender, direction and trimmed text, and their ids must be in *different* namespaces. A legitimately repeated message is rendered in one namespace, so it stays a distinct message. Later observations of the merged-away id resolve to the canonical id, so the same DOM record cannot become new work after a re-render.

Mention packets take context from the store (newest 20) plus the rendered window. The packet builder removes duplicates, so no message is included twice and the trigger appears once as new work. RNG packets take the newest 10 stored messages. Capacity is not tied to the poll window.

## Identity and Personality

The configured puppet name is the bot's identity. It is retrieved from the Messenger profile during startup (falling back to the saved value) and combined with the narrowed Alias Engine output into a system-level identity instruction that states whose messages the assistant turns are, which `@`-mentions refer to the bot, and that literal requests must be reproduced as written. Identity is derived from configuration and is never hardcoded.

Personality is a separate layer: the built-in default instruction, or a custom instruction composed with the fixed behavioral layer. `setpersonality` changes the personality layer at runtime; identity is re-composed around it, so a personality change cannot remove the bot's identity. Personality governs conversational style and never decides whether the bot participates.

The bot temperament (`quiet`, `balanced`, or `talkative`) is stored in `config.json` and maps to RNG participation probabilities. It is independent of both identity and personality, and `setbottemp` updates a running engine without pausing, resuming, or restarting it.

## RNG Participation

Independently of mentions, the engine evaluates an RNG opportunity every 15 seconds. It skips when the main poll is in progress, when a mention packet is open or queued or active, when a generation is already in flight, or while a cooldown is active. It also skips when the newest stored message is `OUTGOING` and requires at least one usable `INCOMING` message in the newest 10. A successful roll builds a packet from those 10 messages and submits it like any other packet. Any successful reply (mention or RNG) starts a 35-second cooldown, so one conversation turn cannot produce two immediate replies.

## Lifecycle and Failure Behavior

- **Pause and resume:** observation and packet work are suspended; the current poll is allowed to finish. Resume restarts polling and RNG evaluation and re-arms the idle timer.
- **Destination switching:** reject concurrent switches, pause, navigate and verify the new destination with a rendered-message baseline, persist the destination, discard queued work, reseed the Context Store from the new baseline, and resume only after verification. A failed switch returns to the previous destination and leaves the configuration unchanged.
- **Stop:** reject new work, cancel pending packets and in-flight gating, detach the console listener and page observer, wait for the packet processor to settle, and close the managed browser.
- **Browser or CDP failure:** stop the engine and report the failure; recovery requires another `start`.
- **NVIDIA failure:** the packet is recorded as failed and processing moves on. There is no automatic retry, and no reply is sent for a failed generation.
- **Uncertain send outcome:** a composer click is reported as an attempt; the engine does not resend.

## Safety Invariants

- Track ownership of the browser process launched by the application; never stop unrelated browser instances.
- Keep CDP bound to loopback and connect only to the managed browser.
- Do not silently change the active tab or destination; verify a destination switch before resuming replies.
- Only explicitly `INCOMING` messages may trigger mention-based replies; `OUTGOING` and `UNKNOWN` messages never can, and the guard does not depend on alias matching alone.
- Deduplicate by stable message ID, never by message text alone. The only exception is one logical message exposed under two id namespaces, reconciled only when the records are adjacent in rendered order, share sender, direction and text, and their ids are in different namespaces.
- Keep each message's `messageId`, text, `sender`, and `direction` in observation order.
- Do not make reply decisions from unknown or stale message identity or direction.
- Never run a second generation or send concurrently with an active packet.
- Keep credentials, recovery PINs, API keys, session data, and runtime state outside the repository.
- Keep AI generation separate from participation decisions and browser actions.

## Milestones

- **M0 — Foundation**
- **M1 — Browser + CLI Lifecycle ("Cranking")**
- **M2 — Ignition + Running:** transition from the proven one-shot pipeline to a persistent, decision-driven conversation engine.
- **M3 — Hardening & Polishing**

M2 development stages, in order, are **fresh-message detection**, **batching/decisions**, **continuous loop**, **lifecycle/recovery**, and **end-to-end testing**. These are work stages within M2, not official milestones.

## Implemented and Proven Boundaries

- Production startup validates the configured NVIDIA API key, launches the managed browser, prepares the configured conversation, handles login and Messenger startup challenges, retrieves the puppet name, initializes the Alias Engine, and seeds the Context Store from Backread.
- Production runtime observation, stable-ID deduplication, mention-triggered packet building, FIFO scheduling, generation, pre-send gating, and single-click composition are implemented and covered by offline tests.
- Production generation builds an identity-plus-personality system instruction and a role-attributed, ID-deduplicated conversation request; the composer checks the composer and send control before clicking. Message readers report each merge once (`[identity] merged duplicate rendered record` in the engine, a Backread diagnostic at startup) with the observed and canonical ids, direction, sender, character count and a text fingerprint.
- Backread is bounded (up to 30 messages) and runs only during initialization.
- The RNG participation path, cooldown, pause/resume, destination switching, and shutdown are implemented and covered by offline tests.
- Scripts in `Tools/` are exploratory, independent experiments. They can provide evidence for the specific behaviors they exercise but do not establish managed-startup, live-Messenger, or live-NVIDIA behavior.

Messenger's rendered structure can change, so verification should exercise the production path and preserve the send-outcome distinction. Live smoke testing remains the repository owner's step for confirming real conversation quality, delivery behavior, and NVIDIA response characteristics.
