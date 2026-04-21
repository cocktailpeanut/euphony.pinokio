# Euphony Codex Browser

This Pinokio launcher installs [OpenAI Euphony](https://github.com/openai/euphony), builds the frontend-only static app, and starts a local browser that discovers Codex session logs from `~/.codex/sessions/**/*.jsonl`.

## Use

1. Click **Install**.
2. Click **Start**.
3. Open **Codex Sessions** from the launcher menu.
4. Pick any discovered session to view it in Euphony.

The local browser runs on `127.0.0.1` and serves session files only from your Codex sessions directory. The Euphony links use `?path=<local-session-url>&frontend-only=true` so Euphony can render each JSONL session without manual upload.

## Scripts

- `install.js`: clones Euphony into `app`, installs Node dependencies, and builds the frontend-only static app.
- `start.js`: starts the local Codex session browser and exposes its URL to Pinokio.
- `update.js`: pulls the latest Euphony code, reinstalls dependencies, and rebuilds the frontend-only static app.
- `reset.js`: removes `app` so installation can start from a clean clone.

## Local API

After **Start**, replace `BASE_URL` below with the browser URL printed in the terminal or opened by the launcher.

### JavaScript

```js
const baseURL = "BASE_URL";
const sessions = await fetch(`${baseURL}/api/sessions`).then(r => r.json());
const latest = sessions.sessions[0];
const sessionURL = `${baseURL}/session/${latest.token}.jsonl`;
const euphonyURL = `${baseURL}/euphony/?path=${encodeURIComponent(sessionURL)}&frontend-only=true`;
console.log(euphonyURL);
```

### Python

```python
import urllib.parse
import urllib.request
import json

base_url = "BASE_URL"
with urllib.request.urlopen(f"{base_url}/api/sessions") as response:
    payload = json.load(response)

latest = payload["sessions"][0]
session_url = f"{base_url}/session/{latest['token']}.jsonl"
euphony_url = f"{base_url}/euphony/?path={urllib.parse.quote(session_url, safe='')}&frontend-only=true"
print(euphony_url)
```

### Curl

```bash
curl BASE_URL/api/sessions
curl BASE_URL/session/TOKEN.jsonl
```

Open a session directly:

```text
BASE_URL/euphony/?path=ENCODED_SESSION_URL&frontend-only=true
```
