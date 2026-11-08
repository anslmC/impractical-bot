# impractical-bot

A local Node.js CLI for a safety-conscious Facebook Messenger bot. It observes messages, answers explicitly incoming mentions, and can participate through a temperament-driven RNG path.

## Overview

In normal operation, the CLI validates the NVIDIA API key, launches and prepares the configured browser, handles login and Messenger startup challenges, seeds context from Backread, and runs the continuous Combustion engine. It polls rendered messages, answers explicitly incoming mentions through FIFO packets, may participate through the RNG path, and uses the composer for one send attempt per reply. A composer click is not confirmation of delivery.

The runtime launches the configured browser with a dedicated profile and connects Playwright through a loopback-only CDP endpoint. It tracks ownership of the browser process it launches and does not terminate unrelated browser instances. Continuous observation, mention replies, and RNG participation run through the same engine.

The standalone JavaScript maintenance utilities in `Tools/utilities/` are optional local tools and are not part of the CLI build. Brave, Google Chrome, and Microsoft Edge are supported; Firefox is not. See [ARCHITECTURE.md](ARCHITECTURE.md) for the runtime pipeline and current limitations.

## Requirements

- Node.js 22.13 or newer
- npm compatible with the installed Node.js release

## Installation

```powershell
npm install
npm run build
npm link
```

`npm link` links the local package into your global npm prefix so the `impbot` command is available. Run `impbot --help` to verify the installation.

## Usage

```powershell
impbot init
impbot start
impbot pause
impbot resume
impbot stop
impbot deletealldata
```

`impbot init` configures the browser, Messenger destination, bot temperament, personality, and optional Messenger PIN restoration. `impbot config` prints the current configuration. `impbot updatekey` replaces the NVIDIA API key, and `impbot start --debug` opens the debug log view. Run `impbot --help` for the full command list.

`impbot deletealldata` permanently deletes the default local application data directory at `%LOCALAPPDATA%\Impractical Bot`. This removes application configuration, locally stored NVIDIA credentials, default browser profiles and session data, and other application-generated files within that directory. The command requires you to type `DELETE` to confirm and refuses to run while the bot engine is active; run `impbot stop` first. Browser profiles stored outside the application data directory are not included. This command does not uninstall the application or remove its npm package.

## Development

The runtime is written in TypeScript under `src/`, compiled for Node.js using the NodeNext module model. Automated tests use Node's built-in test runner. Standalone maintenance utilities remain in `Tools/utilities/` and are not part of the production build.

- `npm run build` compiles TypeScript into `dist/`.
- `npm run lint` runs ESLint against the project, excluding `Tools/` and generated output.
- `npm test` builds the TypeScript and runs tests with Node's built-in test runner.

## Verification

Automated tests cover the offline runtime pipeline. They do not validate live Messenger behavior. Messenger's rendered structure and NVIDIA responses can change, so verify the live path with a smoke test before relying on it. A composer click is a send attempt, not confirmed delivery.

## Local Data and Secrets

The configuration is stored under `%LOCALAPPDATA%\Impractical Bot` on Windows by default. The bot temperament (`quiet`, `balanced`, or `talkative`) is saved in `config.json` and sets RNG probability/cooldown independently: Quiet is 10%/25 seconds, Balanced is 50%/15 seconds, and Talkative is 95%/6 seconds; `balanced` is the default. These settings do not change the 1500 ms runtime poll interval. The NVIDIA API key is stored as `NVIDIA_API_KEY` in an ignored `.env` file beside `config.json`; a custom configuration path uses its containing directory. `init` and `updatekey` validate keys before saving. Normal `start` validates the application key before launching the browser; setting `IMPRACTICAL_BOT_DEBUG=1` skips that validation for local troubleshooting. Shell-provided `NVIDIA_API_KEY` values are not used. Credentials, recovery PINs, API keys, browser session data, and runtime state must remain outside the repository.

See [Privacy](#privacy) and [Security](#security) below for the full data-flow, logging, and deletion details.

## Privacy

Impractical Bot runs locally, but it is not a fully offline application. It sends conversation content to NVIDIA for AI processing and displays conversation text in its runtime interface.

### External AI processing

When generating a reply, the application sends an HTTPS request to `https://integrate.api.nvidia.com/v1/chat/completions` using the `nvidia/nemotron-3.5-lightning-30b-a3b` model. The request can contain:

- Incoming message text, sender names, participant names, timestamps, direction, message IDs, and addressee or target metadata from the recent conversation.
- Recent outgoing or bot-authored messages used as conversation context. Only the newest three logical assistant reply batches are included; incoming messages in the selected context window are retained.
- The configured bot identity, aliases, known participant names, group roster first names, personality and custom instruction, and the system instructions used for targeting, time awareness, memory, and reply style.
- The generated reply prompts and any validation or retry instructions.

This information leaves your machine and is processed by NVIDIA. Impractical Bot does not control NVIDIA's retention, logging, or training practices and makes no claims about them here. Review NVIDIA's applicable API terms and privacy documentation for how NVIDIA handles data sent to its API. As with any HTTPS request, NVIDIA also receives network-level information such as your IP address.

The application does not send your NVIDIA API key to the model as message content; the key is used in the HTTP Authorization header. The application does not intentionally send your browser cookies, browser profile, local files, Messenger PIN, or Windows account data to NVIDIA.

### Local data

By default, application data is stored under `%LOCALAPPDATA%\Impractical Bot` on Windows:

- `config.json` contains the selected browser and executable path, the dedicated profile path, CDP port, startup URL, Messenger destination, bot name, temperament, personality settings, composer slicer settings, and PIN-restoration settings. If PIN restoration is enabled, the six-digit Messenger recovery PIN is stored there in plaintext.
- `.env` contains the `NVIDIA_API_KEY` credential.
- The dedicated browser profile is stored in a subdirectory named `chrome-profile`, `brave-profile`, or `msedge-profile`, based on the selected browser. It can contain cookies, local storage, cache, history, saved logins or autofill data, and the Messenger session. The profile persists across runs until you delete it.
- The engine keeps recent conversation context (up to 60 messages), packet state, and other runtime data in memory while it runs. The dashboard and debug log buffer keep up to 200 entries in memory. The application does not create persistent application log files.
- The running engine uses a local named pipe for control and status requests, including pause, resume, stop, destination changes, temperament changes, personality changes, and status polling. It is not a file and disappears when the engine exits.
- Atomic configuration writes briefly create a hidden temporary file in the same directory; it is removed after a successful write and on handled failures.

If you use a custom configuration path, these files are stored beside that path instead. The `profilePath` recorded in `config.json` is the authoritative location of the browser profile.

### Logging

Runtime output is printed to the terminal and captured by the dashboard or debug view in an in-memory buffer. Impractical Bot does not write application log files to disk, but your terminal scrollback, screen recorder, shell redirection, or operating-system diagnostics may retain the output.

Conversation text can appear in normal runtime logs. Message-detection, packet-content, duplicate-identity, and generation diagnostics can include message text, sender or participant names, message IDs, and short reply previews (normally up to 160 characters). Setting `IMPBOT_DEBUG=1` adds more diagnostic detail, including short AI request previews (normally up to 80 characters). The `impbot start --debug` view displays the same runtime logs in a debug-oriented interface. Treat terminal output and debug logs as sensitive.

### Retention and deletion

`impbot stop` stops the engine and closes the managed browser, but it does not delete configuration, credentials, the PIN, the browser profile, or terminal scrollback. `impbot deletealldata` permanently deletes the default application data directory after you type `DELETE` to confirm; it refuses while the engine is running. Neither command removes terminal scrollback.

To remove local data:

1. Stop the bot with `impbot stop` and close its terminal.
2. To remove all default application data, run `impbot deletealldata`, or delete `%LOCALAPPDATA%\Impractical Bot` manually. This removes `config.json`, `.env`, and the default browser profile directories.
3. If `config.json` uses a custom `profilePath`, delete that profile directory separately.
4. To remove only the API key, delete the `.env` file beside `config.json`. `impbot updatekey` replaces the key; it does not remove it.
5. To remove only the stored PIN, delete `config.json` and run `impbot init` again if you want to recreate the configuration. Removing the browser profile is separate.
6. Deleting the browser profile logs the Messenger session out of that profile and will normally require you to authenticate again on the next start.

Deleting files removes the active local copies. Backups, sync services, terminal buffers, and forensic copies are outside the application's control.

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

### NVIDIA API Key Storage

Your NVIDIA API key is stored locally in the application's `.env` file, separate from your main configuration.

**Security notice:** Treat this file as sensitive. Anyone with access to your Windows user account and application data may be able to retrieve the key. Avoid sharing the file, committing it to version control, or including it in untrusted backups. If the key is exposed, revoke or rotate it through NVIDIA, generate a replacement, and save it with `impbot updatekey`.

### Messenger recovery PIN

If PIN restoration is enabled, the six-digit Messenger PIN is stored in plaintext in `config.json`. It is not encrypted and is not stored in Windows Credential Manager or DPAPI. Anyone who can read the configuration file, its backups, or a copy of the directory can read the PIN.

Protect your Windows account, lock your device when unattended, keep the configuration directory private, and avoid sharing configuration files, backups, or screenshots that contain the PIN. If it is exposed, change the Messenger PIN through your Meta account controls and update the local configuration.

### Browser session and debugging

The application uses a dedicated browser profile rather than your normal browser profile. That profile retains cookies, local storage, and Messenger session data, so it should be treated like account credentials. Do not share or copy the profile directory.

The managed browser exposes the Chrome DevTools Protocol only on loopback (`127.0.0.1`) using a per-configuration port. This is not intended to be reachable from other machines, but other processes running as your Windows user, and administrators, may be able to connect to the local debugging interface. Keep the machine trusted, close the engine when it is not in use, and do not expose or forward the debugging port.

### User responsibilities

- Keep the NVIDIA API key private and rotate it if it is exposed.
- Protect your Windows account with a strong sign-in method and disk encryption where available.
- Do not share browser profiles, configuration files, or backups that contain credentials or session data.
- Do not share terminal output or debug logs without removing conversation content, names, credentials, and identifiers.
- Keep Windows, the browser, and Impractical Bot's dependencies up to date.

## Messenger Automation Disclaimer

Impractical Bot is an independent, community-developed project. It is not affiliated with, endorsed by, or officially supported by Meta Platforms, Inc. Facebook and Messenger are names and trademarks of Meta.

Automating Messenger interactions may violate applicable Meta or Messenger terms and policies. Such activity may result in restrictions, suspension, or termination of accounts. You are responsible for your own use of the software and for complying with applicable terms and laws. Use Impractical Bot only with accounts and conversations you are authorized to access. This project does not provide legal advice.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for the full license text.
