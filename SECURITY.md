# Security Policy

## Supported versions

Security fixes are applied to the latest commit on the default branch (`master`). There are currently no maintained older release lines. If versioned releases are introduced, their support status will be documented in the release notes.

This policy covers the Impractical Bot repository. It does not cover Meta, Messenger, NVIDIA, or browser-vendor services; report issues in those services to the relevant provider.

## Reporting a vulnerability

Please do not report security vulnerabilities in a public GitHub issue.

This project does not currently publish an email address or another private security contact. If the repository's Security tab offers **Report a vulnerability**, use that private GitHub advisory flow. Before a public release, the maintainer must enable GitHub private vulnerability reporting in the repository settings or provide another private channel and update this document.

If private vulnerability reporting is not available, open a minimal public issue that asks only for a private security contact. Do not include vulnerability details, exploit steps, credentials, PINs, API keys, session data, personal message content, or logs in that public issue. The maintainer can then arrange a private channel.

## What to include

A useful report should include:

- The affected commit or version.
- Your Windows version and browser (Brave, Google Chrome, or Microsoft Edge).
- A clear description of the vulnerability and its impact.
- Steps to reproduce it, using synthetic accounts or data where possible.
- Any relevant logs, with API keys, PINs, cookies, session identifiers, personal names, and message content removed.
- Whether you intend to disclose the issue publicly and any deadline you are working toward.

Do not send real credentials, recovery PINs, browser profiles, session data, or private conversation content.

## Coordination and disclosure

Please do not publish exploit details publicly before the maintainer has had a reasonable opportunity to investigate and coordinate a fix. This is a small community project: reports are handled on a best-effort basis, and no response-time guarantee, bug bounty, or guaranteed fix timeline is offered.

The maintainer will try to acknowledge the report, reproduce the issue, assess its impact, prepare a fix on the default branch, and coordinate disclosure with the reporter. Reporters may be credited unless they request anonymity.

## Scope

Examples of in-scope reports include vulnerabilities in Impractical Bot's own code, credential handling, local configuration, browser automation, runtime control, or logging. Issues in Meta or Messenger, NVIDIA's API, or the browser itself should be reported to the relevant provider.
