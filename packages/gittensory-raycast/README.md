# Gittensory Raycast extension

Raycast command surface for [Gittensory](https://github.com/JSONbored/gittensory). The extension authenticates through **GitHub Device Flow** against the **Gittensory API** and stores only a **`gts_` session token** in Raycast `LocalStorage`.

## Package boundaries

| Layer | Responsibility |
| --- | --- |
| `lib/` | API client, device-flow auth, session storage helpers, public-output sanitizer (unit-tested, no Raycast UI imports) |
| `src/` | Raycast commands (`login`, `status`, `logout`) wired to `lib/` |
| Gittensory API | OAuth device flow, session validation, logout revocation |

This package does **not**:

- Store GitHub personal access tokens (PATs are rejected at validation time)
- Upload repository source contents or branch patches
- Embed wallet, hotkey, trust-score, payout, or farming language in user-visible output

Configure the API origin via the **API Origin** preference (default: `https://gittensory-api.aethereal.dev`).

## Local development

```bash
cd packages/gittensory-raycast
npm install
npm run build
npm run test
npm run lint
```

Load the extension in Raycast with **Import Extension** pointed at this directory after `npm run build`.

## Commands

- **Login** — starts device flow, opens the verification URL, polls until a `gts_` session is issued, persists locally
- **Status** — shows signed-in login, API origin, expiry, and scopes (sanitized)
- **Logout** — revokes the remote session when possible and clears local storage
