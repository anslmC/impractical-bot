# impractical-bot

An experimental local project exploring a safety-conscious Facebook Messenger bot. The repository is establishing its development foundation; no production bot workflow is implemented yet.

## Current Status

The project currently contains its TypeScript toolchain, empty production-area placeholders, and independent JavaScript experiments in `Tools/`. The experiments are exploratory scripts, not production modules or automated tests.

The planned browser targets are Brave, Google Chrome, and Microsoft Edge. Firefox is out of scope. CLI commands, browser discovery and lifecycle management, bot orchestration, and AI integration are not implemented. The experiments do not establish that planned production behavior works.

## Intended Operation

The intended application is a local Node.js CLI that will discover and launch a dedicated profile for a supported browser, then use Playwright over a loopback-only CDP endpoint. It must track ownership of the browser process it launches and never terminate unrelated browser instances. These capabilities are planned, not implemented.

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

The intended configuration and runtime state location is the user's local application-data directory, such as `%LOCALAPPDATA%\impractical-bot` on Windows. Credentials, recovery PINs, API keys, browser session data, and runtime state must remain outside the repository. No runtime configuration loader or secret handling is implemented yet.

See [ARCHITECTURE.md](ARCHITECTURE.md) for intended command flows, responsibilities, and safety principles. Planned runtime features are not implemented or verified.
