# Security Policy

AudioSeerr handles logins, API keys and your Lidarr credentials, so security reports are taken seriously.

## Supported versions

Only the [latest release](https://github.com/jordydabs/audioseerr/releases/latest) receives security fixes. Please update before reporting, and check the [changelog](CHANGELOG.md) in case the issue is already fixed.

## Reporting a vulnerability

**Please don't open a public issue for a security problem.**

Report it privately through GitHub instead: **[Report a vulnerability](https://github.com/jordydabs/audioseerr/security/advisories/new)** (Security tab → *Report a vulnerability*). Include:

- what you found and which version it affects,
- steps or a proof of concept to reproduce it,
- the impact you think it has.

AudioSeerr is maintained by one person in their spare time, so replies are best-effort — but security reports come first. Reporters are credited in the release notes if they would like to be.

## Deployment notes

AudioSeerr is designed to sit behind a reverse proxy with TLS rather than be exposed directly to the internet, and an API key is a full-access admin service account by design. See [Security](README.md#security) and [API access](README.md#api-access) in the README for the details.
