# impractical-bot

A local Node.js CLI for a safety-conscious Facebook Messenger bot. The project has a working browser/CLI foundation and a proven one-shot message pipeline; its next milestone is a persistent, decision-driven conversation engine.

## Current Status

Production code validates the NVIDIA API key, launches and prepares the configured browser, handles login and Messenger startup challenges, reads rendered conversation messages, generates a reply, and uses the tested composer to attempt a send. The current `start` flow runs that pipeline once and then waits for shutdown; it is not yet a continuous conversation engine. A composer click is not confirmation of delivery.

JavaScript scripts in `Tools/` are independent experiments, not production modules or automated tests. Brave, Google Chrome, and Microsoft Edge are supported targets; Firefox is out of scope. See [ARCHITECTURE.md](ARCHITECTURE.md) for the implemented/proven boundary and the planned M2 behavior.

## Intended Operation

The application is a local Node.js CLI that launches a dedicated profile and connects Playwright through a loopback-only CDP endpoint. It tracks ownership of the browser process it launches and must not terminate unrelated browser instances. These browser and lifecycle foundations are implemented; continuous observation and reply decisions remain planned.

## Prerequisites

- Node.js 22.13 or newer
- npm compatible with the installed Node.js release

Install project dependencies with `npm install`.

## Development

Production code will be written in TypeScript under `src/`, compiled for Node.js using the NodeNext module model. The package remains compatible with the existing CommonJS JavaScript experiments. Automated tests use Node's built-in test runner. Scripts in `Tools/` remain independent JavaScript experiments; they are neither converted nor run by the project scripts.

- `npm run build` compiles TypeScript into `dist/`.
- `npm run lint` runs ESLint against the project, excluding `Tools/` and generated output.
- `npm test` builds the TypeScript and runs tests with Node's built-in test runner.

## Local Data and Secrets

The configuration is stored under `%LOCALAPPDATA%\Impractical Bot` on Windows by default. The NVIDIA API key is stored as `NVIDIA_API_KEY` in an ignored `.env` file beside `config.json`; a custom configuration path uses its containing directory. `init` and `updatekey` validate keys before saving, and `start` validates the application key before launching the browser. Shell-provided `NVIDIA_API_KEY` values are not used. Credentials, recovery PINs, API keys, browser session data, and runtime state must remain outside the repository.

## Milestones

- **M0 — Foundation**
- **M1 — Browser + CLI Lifecycle ("Cranking")**
- **M2 — Ignition + Running:** transition from the proven one-shot pipeline to a persistent, decision-driven conversation engine.
- **M3 — Hardening & Polishing**

The M2 development stages are fresh-message detection, batching and decisions, the continuous loop, lifecycle and recovery, and end-to-end testing. These are implementation stages within M2, not additional official milestones. M2 target behavior is planned and not yet implemented or verified.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the M2 flow, lifecycle rules, and safety principles.
