# Codex OpenAI Proxy

A small desktop app that exposes a local OpenAI-compatible API backed by your Codex / ChatGPT OAuth login.

The app gives you one switch. Turn it on, then copy the OpenAI Base URL into browser extensions such as Immersive Translate.

## Install

Download the latest installer from GitHub Releases:

<https://github.com/zjy4fun/codex-openai-proxy/releases>

On macOS, open the DMG, drag **Codex OpenAI Proxy** into Applications, then launch it. On Windows, run the `Setup.exe` installer.

If macOS says the app cannot be opened, is damaged, or cannot verify the developer, Gatekeeper is usually blocking the unsigned or unnotarized app. After installing it to Applications, run:

```bash
xattr -rd com.apple.quarantine "/Applications/Codex OpenAI Proxy.app"
```

## Extension Settings

After turning on the switch in the app:

- OpenAI Base URL: `http://127.0.0.1:15721/v1`
- Chat Completions URL: `http://127.0.0.1:15721/v1/chat/completions`
- API Key: any non-empty value, for example `dummy`
- Model: choose any supported model listed by `GET /v1/models`, for example `gpt-5.4-mini`

The app shows the supported model list and lets you change the proxy port. If you change the port while the proxy is running, the app restarts the proxy on the new port and updates the displayed URLs.

## macOS Menu Bar

On macOS, Codex OpenAI Proxy also appears in the menu bar. From there you can turn the proxy on or off, show the main window, copy the local URLs, check for updates, or quit the app.

## Updates

Starting with `v0.1.4`, the app checks GitHub Releases after launch and can hot-update by downloading the published `app.asar` package instead of the full installer. You can also run **检查更新...** from the application menu.

## Requirements

You must already be logged in with Codex or CC Switch on the same Mac. The app reads OAuth state from one of:

- `~/.codex/auth.json`
- `~/.cc-switch/codex_oauth_auth.json`

No OpenAI API key is required.

## How It Works

The app listens on `127.0.0.1:15721` only when the switch is on. It accepts OpenAI Chat Completions requests, uses your local Codex OAuth token to call `https://chatgpt.com/backend-api/codex/responses`, then converts the streamed Responses API output back into OpenAI-compatible Chat Completions responses.

## Development

```bash
npm install
npm start
```

Build a local macOS DMG:

```bash
npm run dist
```

## Release

Push a semver tag to trigger GitHub Actions:

```bash
git tag v0.1.6
git push origin main --tags
```

The workflow builds macOS `.dmg` / `.zip`, Windows `.exe` / `.zip`, update metadata, and the `app.asar` hot-update asset, then publishes them to GitHub Releases.
