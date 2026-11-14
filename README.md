<p align="center">
  <img src="assets/readme-wordmark.svg" alt="Impractical Bot block-letter wordmark with the tagline Messenger Conversation Engine" width="780">
</p>

Impractical Bot is a local Node.js CLI that watches a Facebook Messenger conversation, replies when someone mentions it, and sometimes jumps into the chat on its own depending on its temperament. It drives a real browser, so it sees the conversation the way you do.

Published as [`@anselm000/impbot`](https://www.npmjs.com/package/@anselm000/impbot). The installed command is `impbot`.

## Features

- Watches a chosen Messenger conversation in a dedicated browser profile.
- Replies to explicit incoming mentions.
- Can occasionally join in on its own with a `quiet`, `balanced`, or `talkative` temperament.
- Supports a default or custom personality.
- Composer Slicer splits long outgoing replies into chunks with a configurable limit.
- Includes a terminal dashboard and an optional debug view.
- Runs locally, apart from the NVIDIA API calls used to generate replies.

## Requirements

- Windows (the CLI uses Windows paths, local browser discovery, and PowerShell checks).
- Node.js 22.13.0 or newer, with a compatible npm.
- Brave, Google Chrome, or Microsoft Edge. Firefox is not supported.
- A Facebook/Messenger account with access to the conversation you want to watch.
- An NVIDIA API key accepted by NVIDIA's chat completions API.
- Network access to Facebook/Messenger and NVIDIA.

## Installation

Install the published package globally:

```powershell
npm install -g @anselm000/impbot
impbot --version
```

This installs `@anselm000/impbot` and makes the `impbot` command available. If `impbot` is not recognized, reopen your terminal so the updated PATH is loaded. Run `impbot --help` for the full command list.

## Getting Started

1. Run `impbot init`.
2. Choose a supported browser and paste the Messenger conversation URL to watch (for example, `https://www.facebook.com/messages/t/<conversation-id>`).
3. Pick a temperament and personality, and decide whether to enable Messenger PIN restoration.
4. Enter your NVIDIA API key when prompted. `impbot init` validates it before saving.
5. Run `impbot start`. If the managed browser profile is not signed in, sign in to Facebook/Messenger in that window. Startup waits for login, handles the Messenger startup dialogs, seeds recent context, and begins observing the conversation.

The bot uses a dedicated browser profile, separate from your normal browser profile, so your existing browser session is not reused.

## Commands

| Command | What it does |
| --- | --- |
| `impbot init` | Set up the browser, Messenger destination, temperament, personality, optional PIN restoration, and API key. |
| `impbot start` | Start the bot. Add `--debug` to open the debug log view. |
| `impbot pause` | Pause observation and replies. |
| `impbot resume` | Resume after a pause. |
| `impbot stop` | Stop the engine and close the managed browser. Does not delete local data. |
| `impbot config` | Print the current configuration. Read-only; it does not change settings. |
| `impbot changebrowser` | Change the configured browser. Stops a running engine before saving. |
| `impbot changemsgUrl` | Change the Messenger destination. |
| `impbot setbottemp` | Set the temperament (`quiet`, `balanced`, or `talkative`). |
| `impbot setpersonality` | Set the personality. |
| `impbot setcomposerslicer` | Configure Composer Slicer with `enabled <true/false>`, `maxCharacters <positive-integer>`, or `status`. Changes apply after the engine restarts. |
| `impbot updatekey` | Replace the NVIDIA API key. Validates the key before saving. |
| `impbot deletealldata` | Permanently delete `%LOCALAPPDATA%\Impractical Bot` after typing `DELETE`. Refuses while the engine is running and does not uninstall the package. |

## Privacy and Security

Impractical Bot runs locally, but it is not fully offline. When generating a reply, it sends conversation content over HTTPS to NVIDIA for AI processing, including message text, participant and sender names, timestamps, recent context, the bot's identity and personality settings, and the prompts used to generate a reply.

NVIDIA's retention, logging, and training practices are outside this project's control. Review NVIDIA's applicable API terms and privacy documentation.

- The NVIDIA API key is sent in the HTTP Authorization header, not as message content.
- The application does not intentionally send browser cookies, the browser profile, local files, the Messenger PIN, or Windows account data to NVIDIA.
- Local application data lives in `%LOCALAPPDATA%\Impractical Bot` by default:
  - `config.json` contains settings and, if PIN restoration is enabled, the six-digit Messenger PIN in plaintext.
  - `.env` contains the NVIDIA API key in plaintext.
  - The dedicated browser profile contains cookies, local storage, and Messenger session data. Treat it like account credentials.
- Terminal, dashboard, and debug output may contain conversation text and names. Treat logs as sensitive. The application does not create persistent log files.
- `impbot stop` stops the engine and closes the browser, but it does not delete configuration, credentials, the PIN, the browser profile, or terminal scrollback.
- `impbot deletealldata` permanently deletes the default data directory after you type `DELETE`, and it refuses while the engine is running. Backups, sync services, and terminal buffers are outside the application's control.
- Keep your NVIDIA API key and Messenger PIN private. If either is exposed, rotate the key with `impbot updatekey` and change the PIN through your Meta account controls.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and [ARCHITECTURE.md](ARCHITECTURE.md) for runtime details.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `impbot` is not recognized | Reopen the terminal, then check that your npm global prefix is on PATH. |
| `Configuration has not been initialized` | Run `impbot init`. |
| NVIDIA key is missing or invalid | Run `impbot updatekey` with a valid key. |
| An engine is already running | Run `impbot stop` before `init`, `updatekey`, or `deletealldata`. |
| Browser discovery fails | Install Brave, Google Chrome, or Microsoft Edge, then run `impbot init` or `impbot changebrowser`. |
| Login, PIN, or destination errors | Sign in to the managed browser window, use a Messenger conversation URL, and check the PIN if restoration is enabled. |

For startup diagnostics, run `impbot start --debug`.

## Contributing

The runtime is TypeScript under `src/` and compiles with `npm run build`. Tests use Node's built-in runner (`npm test`), and linting uses `npm run lint`. From a source checkout, run `npm install`, then `npm run build`, then `npm link` to make the local build available as `impbot`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the runtime pipeline and current limitations. The standalone utilities in `Tools/utilities/` are optional local tools and are not part of the published CLI.

## Disclaimer

Impractical Bot is an independent, community-developed project. It is not affiliated with, endorsed by, or officially supported by Meta Platforms, Inc. Facebook and Messenger are names and trademarks of Meta.

Automating Messenger interactions may violate applicable Meta or Messenger terms and policies, and may result in restrictions, suspension, or termination of accounts. You are responsible for your own use of the software and for complying with applicable terms and laws. Use Impractical Bot only with accounts and conversations you are authorized to access. This project does not provide legal advice.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for the full license text.
