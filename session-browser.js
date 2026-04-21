const fs = require("fs")
const fsp = require("fs/promises")
const http = require("http")
const os = require("os")
const path = require("path")
const { URL } = require("url")

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_CODEX_ROOT = path.join(os.homedir(), ".codex")
const SESSION_SCAN_LIMIT = 5000
const METADATA_READ_BYTES = 512 * 1024

function parseArgs(argv) {
  const result = {
    host: process.env.HOST || DEFAULT_HOST,
    port: Number(process.env.PORT || 0),
    codexRoot: process.env.CODEX_HOME || DEFAULT_CODEX_ROOT
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--host" && argv[i + 1]) {
      result.host = argv[++i]
    } else if (arg === "--port" && argv[i + 1]) {
      result.port = Number(argv[++i])
    } else if (arg === "--codex-root" && argv[i + 1]) {
      result.codexRoot = argv[++i]
    }
  }

  result.codexRoot = path.resolve(result.codexRoot.replace(/^~(?=$|\/|\\)/, os.homedir()))
  return result
}

function toToken(relativePath) {
  return Buffer.from(relativePath, "utf8").toString("base64url")
}

function fromToken(token) {
  return Buffer.from(token, "base64url").toString("utf8")
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function clipText(value, maxLength = 180) {
  const text = normalizeText(value)
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1)}...`
}

function contentToText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map(contentToText).filter(Boolean).join(" ")
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text
    if (typeof content.message === "string") return content.message
    if (Array.isArray(content.parts)) return content.parts.map(contentToText).join(" ")
  }
  return ""
}

async function readMetadata(filePath) {
  let fd
  try {
    fd = await fsp.open(filePath, "r")
    const buffer = Buffer.alloc(METADATA_READ_BYTES)
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0)
    const text = buffer.toString("utf8", 0, bytesRead)
    const lines = text.split(/\r?\n/)

    let sessionMeta = {}
    let turnContext = {}
    let firstUser = ""
    let firstAssistant = ""

    for (const line of lines) {
      if (!line.trim()) continue

      let event
      try {
        event = JSON.parse(line)
      } catch (_) {
        continue
      }

      const payload = event && typeof event === "object" ? event.payload || {} : {}
      if (event.type === "session_meta" && payload && typeof payload === "object") {
        sessionMeta = payload
      } else if (event.type === "turn_context" && payload && typeof payload === "object") {
        turnContext = payload
      } else if (event.type === "response_item" && payload && payload.type === "message") {
        const textValue = contentToText(payload.content)
        if (payload.role === "user" && !firstUser) firstUser = textValue
        if (payload.role === "assistant" && !firstAssistant) firstAssistant = textValue
      } else if (event.type === "event_msg" && payload && payload.type === "user_message" && !firstUser) {
        firstUser = contentToText(payload.message)
      } else if (event.type === "event_msg" && payload && payload.type === "agent_message" && !firstAssistant) {
        firstAssistant = contentToText(payload.message)
      }
    }

    return {
      id: sessionMeta.id || null,
      startedAt: sessionMeta.timestamp || null,
      cwd: sessionMeta.cwd || turnContext.cwd || null,
      cliVersion: sessionMeta.cli_version || null,
      source: sessionMeta.source || null,
      model: turnContext.model || sessionMeta.model || sessionMeta.model_provider || null,
      firstUser: clipText(firstUser),
      firstAssistant: clipText(firstAssistant)
    }
  } finally {
    if (fd) await fd.close()
  }
}

async function walkJSONL(root) {
  const files = []

  async function walk(dir) {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (_) {
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath)
      }
    }
  }

  await walk(root)
  return files
}

async function scanSessions(codexRoot) {
  const sessionsRoot = path.join(codexRoot, "sessions")
  const files = await walkJSONL(sessionsRoot)
  const stats = await Promise.all(files.map(async filePath => {
    const stat = await fsp.stat(filePath)
    return { filePath, stat }
  }))
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)

  const selected = stats.slice(0, SESSION_SCAN_LIMIT)
  const records = await Promise.all(selected.map(async ({ filePath, stat }) => {
    const relativePath = path.relative(sessionsRoot, filePath)
    const metadata = await readMetadata(filePath)
    const title =
      metadata.firstUser ||
      (metadata.cwd ? path.basename(metadata.cwd) : "") ||
      path.basename(filePath, ".jsonl")

    return {
      token: toToken(relativePath),
      relativePath,
      filename: path.basename(filePath),
      title: clipText(title, 100),
      snippet: metadata.firstAssistant,
      cwd: metadata.cwd,
      model: metadata.model,
      cliVersion: metadata.cliVersion,
      source: metadata.source,
      startedAt: metadata.startedAt,
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
      sizeBytes: stat.size,
      id: metadata.id
    }
  }))

  records.sort((a, b) => {
    const left = Date.parse(b.startedAt || b.modifiedAt)
    const right = Date.parse(a.startedAt || a.modifiedAt)
    return left - right
  })

  return {
    codexRoot,
    sessionsRoot,
    count: records.length,
    totalDiscovered: files.length,
    limit: SESSION_SCAN_LIMIT,
    sessions: records
  }
}

function resolveSessionPath(codexRoot, token) {
  const sessionsRoot = path.join(codexRoot, "sessions")
  const relativePath = fromToken(token.replace(/\.jsonl$/, ""))
  const fullPath = path.resolve(sessionsRoot, relativePath)
  if (!isInside(sessionsRoot, fullPath) || !fullPath.endsWith(".jsonl")) {
    throw new Error("Invalid session path")
  }
  return fullPath
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".html") return "text/html; charset=utf-8"
  if (ext === ".js") return "text/javascript; charset=utf-8"
  if (ext === ".css") return "text/css; charset=utf-8"
  if (ext === ".svg") return "image/svg+xml"
  if (ext === ".json") return "application/json; charset=utf-8"
  if (ext === ".ico") return "image/x-icon"
  if (ext === ".png") return "image/png"
  if (ext === ".woff2") return "font/woff2"
  return "application/octet-stream"
}

function injectEuphonyScrollPatch(html) {
  const patch = `<script>
(function () {
  function applyPinokioEuphonyPatch() {
    var host = document.querySelector("euphony-app");
    if (!host || !host.shadowRoot) {
      window.requestAnimationFrame(applyPinokioEuphonyPatch);
      return;
    }

    if (!host.shadowRoot.getElementById("pinokio-scroll-fix")) {
      var style = document.createElement("style");
      style.id = "pinokio-scroll-fix";
      style.textContent = ".app{height:100vh !important;height:100dvh !important;overflow-y:auto !important;overscroll-behavior:contain;} .content{min-height:0;}";
      host.shadowRoot.appendChild(style);
    }

    var logo = host.shadowRoot.querySelector(".header .name");
    if (!logo) {
      window.requestAnimationFrame(applyPinokioEuphonyPatch);
      return;
    }

    logo.setAttribute("href", "/");
    if (logo.dataset.pinokioHome !== "true") {
      logo.dataset.pinokioHome = "true";
      logo.addEventListener("click", function (event) {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        window.location.href = "/";
      });
    }
  }

  if (window.customElements && window.customElements.whenDefined) {
    window.customElements.whenDefined("euphony-app").then(applyPinokioEuphonyPatch);
  } else {
    window.addEventListener("load", applyPinokioEuphonyPatch);
  }
})();
</script>`

  if (html.includes("</body>")) {
    return html.replace("</body>", `${patch}</body>`)
  }
  return `${html}${patch}`
}

async function sendJSON(res, value, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  })
  res.end(JSON.stringify(value, null, 2))
}

async function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  })
  res.end(text)
}

async function serveSession(req, res, codexRoot, pathname) {
  const token = decodeURIComponent(pathname.slice("/session/".length))
  let fullPath
  try {
    fullPath = resolveSessionPath(codexRoot, token)
  } catch (_) {
    await sendText(res, 400, "Invalid session token")
    return
  }

  let stat
  try {
    stat = await fsp.stat(fullPath)
  } catch (_) {
    await sendText(res, 404, "Session not found")
    return
  }

  if (!stat.isFile()) {
    await sendText(res, 404, "Session not found")
    return
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Content-Length": stat.size,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff"
  })
  fs.createReadStream(fullPath).pipe(res)
}

async function serveEuphony(res, pathname) {
  const distRoot = path.resolve(__dirname, "app", "dist")
  const prefix = "/euphony/"
  const relativeURLPath = pathname === "/euphony" ? "" : pathname.slice(prefix.length)
  const decoded = decodeURIComponent(relativeURLPath || "index.html")
  let candidate = path.resolve(distRoot, decoded)

  if (!isInside(distRoot, candidate)) {
    await sendText(res, 404, "Not found")
    return
  }

  try {
    const stat = await fsp.stat(candidate)
    if (stat.isDirectory()) candidate = path.join(candidate, "index.html")
  } catch (_) {
    candidate = path.join(distRoot, "index.html")
  }

  try {
    const stat = await fsp.stat(candidate)
    if (!stat.isFile()) throw new Error("Not a file")
    if (path.basename(candidate) === "index.html") {
      const html = await fsp.readFile(candidate, "utf8")
      const body = injectEuphonyScrollPatch(html)
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store"
      })
      res.end(body)
      return
    }
    if (path.basename(candidate) === "global.css") {
      const css = await fsp.readFile(candidate, "utf8")
      const override = `

html,
body {
  background: #ffffff;
}

euphony-app {
  display: block;
  width: 100%;
  height: 100vh;
  height: 100dvh;
  min-height: 100%;
  background: #ffffff;
}
`
      const body = `${css}${override}`
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store"
      })
      res.end(body)
      return
    }
    res.writeHead(200, {
      "Content-Type": contentTypeFor(candidate),
      "Content-Length": stat.size,
      "Cache-Control": "no-store"
    })
    fs.createReadStream(candidate).pipe(res)
  } catch (_) {
    await sendText(res, 404, "Euphony has not been built. Run Install first.")
  }
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function renderIndexHTML() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Euphony Codex Browser</title>
  <style>
    :root {
      color-scheme: light;
      --gray-50: hsl(0, 0%, 98%);
      --gray-100: hsl(0, 0%, 96%);
      --gray-200: hsl(0, 0%, 90%);
      --gray-300: hsl(0, 0%, 83%);
      --gray-400: hsl(0, 0%, 65%);
      --gray-500: hsl(0, 0%, 48%);
      --gray-600: hsl(0, 0%, 38%);
      --gray-700: hsl(0, 0%, 29%);
      --gray-800: hsl(0, 0%, 20%);
      --gray-900: hsl(0, 0%, 12%);
      --blue-50: hsl(205, 86.67%, 94.12%);
      --blue-100: hsl(207, 88.89%, 85.88%);
      --blue-700: hsl(209, 78.72%, 46.08%);
      --blue-800: hsl(211, 80.28%, 41.76%);
      --green-50: hsl(125, 39%, 94%);
      --green-100: hsl(122, 38%, 84%);
      --green-700: hsl(122, 39%, 35%);
      --green-800: hsl(123, 43%, 29%);
      --purple-50: hsl(292, 44.44%, 92.94%);
      --purple-100: hsl(291, 46.07%, 82.55%);
      --purple-700: hsl(282, 67.88%, 37.84%);
      --orange-50: hsl(37, 100%, 94%);
      --orange-800: hsl(33, 100%, 32%);
      --font-d2: 0.875rem;
      --font-d3: 0.8125rem;
      --font-d4: 0.75rem;
      --border-radius: 5px;
      --landing-content-width: min(1080px, calc(100vw - 160px));
      --shadow-border-card:
        0 0 1px hsla(0, 0%, 0%, 0.1),
        0 0 1px hsla(0, 0%, 0%, 0.1),
        0 0 2px hsla(0, 0%, 0%, 0.1),
        0 0 12px hsla(0, 0%, 0%, 0.05);
      --font-family-monospace: ui-monospace, Menlo, Monaco, Consolas,
        "Liberation Mono", "Courier New", monospace;
    }

    * { box-sizing: border-box; }

    html {
      font-size: 16px;
      -moz-osx-font-smoothing: grayscale;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
      -webkit-text-size-adjust: 100%;
      -moz-text-size-adjust: 100%;
      scroll-behavior: smooth;
      overflow-x: hidden;
    }

    body {
      margin: 0;
      padding: 0;
      background: white;
      color: var(--gray-700);
      font-family:
        -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans,
        Ubuntu, Cantarell, "Helvetica Neue", sans-serif;
      font-size: 1rem;
      font-weight: 400;
      line-height: 1.5;
    }

    a {
      color: rgb(0, 100, 200);
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    .app {
      width: 100%;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      align-items: center;
      box-sizing: border-box;
      overflow-x: hidden;
    }

    .header {
      width: 100%;
      padding: 20px 0;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 10px;
      position: sticky;
      top: 0;
      background: linear-gradient(
        to bottom,
        rgba(255, 255, 255, 1) 20%,
        rgba(255, 255, 255, 0.9) 80%,
        rgba(255, 255, 255, 0) 100%
      );
      z-index: 3;
    }

    .name {
      color: inherit;
      font-weight: 700;
      text-decoration: none;
      white-space: nowrap;
    }

    .header input,
    .header select,
    .button,
    button {
      height: 36px;
      border: 1px solid var(--gray-300);
      border-radius: var(--border-radius);
      background: white;
      color: var(--gray-800);
      font: inherit;
      line-height: 1;
    }

    .header input {
      width: min(560px, 52vw);
      padding: 0 14px;
    }

    .header select {
      width: 145px;
      padding: 0 12px;
    }

    button,
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 1px 12px;
      cursor: pointer;
      text-decoration: none;
      white-space: nowrap;
    }

    button:hover,
    .button:hover {
      border-color: var(--gray-400);
      background-color: var(--gray-50);
    }

    input:focus,
    select:focus,
    button:focus-visible,
    .button:focus-visible,
    .conversation-container:focus {
      outline: 2px solid var(--blue-700);
      outline-offset: 2px;
    }

    .content {
      width: 100%;
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      overflow-x: hidden;
    }

    .content-left {
      grid-row: 1 / 2;
      grid-column: 1 / 2;
      height: 100%;
      min-width: 0;
      position: relative;
      container: content-left / inline-size;
      display: flex;
      flex-direction: column;
      pointer-events: none;
    }

    .content-right {
      grid-row: 1 / 2;
      grid-column: 3 / 4;
      position: relative;
      height: 100%;
      width: 100%;
      min-width: 0;
      container: content-right / inline-size;
      display: flex;
      flex-direction: column;
    }

    .content-center {
      width: var(--landing-content-width);
      grid-column: 2 / 3;
      display: flex;
      flex-flow: column nowrap;
      justify-content: flex-start;
      align-items: center;
      position: relative;
      padding: 6px 0 42px;
    }

    .grid-header {
      align-self: flex-start;
      width: 100%;
      font-size: var(--font-d3);
      padding: 0 15px 8px 0;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-flow: row wrap;
      color: var(--gray-500);
    }

    .count-label {
      font-size: 1rem;
      color: var(--gray-700);
      margin-right: 8px;
    }

    .root-label {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .session-list {
      display: contents;
    }

    .conversation-container {
      flex: 0 0 auto;
      position: relative;
      width: 100%;
      margin-bottom: 30px;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      align-items: center;
      box-sizing: border-box;
      background: white;
      border-radius: var(--border-radius);
      box-shadow: var(--shadow-border-card);
      cursor: pointer;
      transition: box-shadow 180ms, outline 180ms, transform 180ms;
    }

    .conversation-container:hover {
      box-shadow:
        0 0 1px hsla(0, 0%, 0%, 0.12),
        0 0 2px hsla(0, 0%, 0%, 0.12),
        0 0 16px hsla(212, 9%, 59%, 0.22);
    }

    .conversation-id {
      --gap: 10px;
      position: absolute;
      left: 0;
      top: 0;
      padding: 0 0 10px 10px;
      transform: translate(-100%, 0);
      display: flex;
      flex-flow: column nowrap;
      gap: 6px;
      align-items: flex-end;
      box-sizing: border-box;
      font-size: var(--font-d2);
      color: var(--gray-400);
      text-decoration: none;
      line-height: 1;
    }

    .conversation-id a {
      color: currentColor;
      text-decoration: none;
      padding: 10px 10px 2px 0;
    }

    .conversation-id a:hover {
      color: var(--gray-600);
      text-decoration: underline;
    }

    .rail-rule {
      width: 20px;
      height: 1px;
      margin-right: 10px;
      background: var(--gray-300);
    }

    .rail-label {
      padding-right: 10px;
      color: var(--gray-500);
      font-size: var(--font-d4);
      text-transform: uppercase;
    }

    .session-toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-flow: row wrap;
      width: 100%;
      padding: 14px 14px 0;
      min-width: 0;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 2px 8px;
      border-radius: var(--border-radius);
      font-size: 1rem;
      line-height: 1.1;
      max-width: 100%;
      overflow-wrap: anywhere;
    }

    .session-pill {
      color: var(--blue-700);
      background: var(--blue-50);
    }

    .model-pill {
      color: var(--purple-700);
      background: var(--purple-50);
    }

    .cli-pill {
      color: var(--gray-600);
      background: var(--gray-100);
    }

    .size-pill {
      color: var(--green-800);
      background: var(--green-50);
    }

    .session-open {
      margin-left: auto;
      min-height: 30px;
      height: 30px;
      color: var(--gray-800);
      background: white;
    }

    .session-preview {
      width: calc(100% - 28px);
      margin: 14px;
      padding: 12px 12px 13px;
      background: var(--gray-100);
      border-left: 3px solid var(--gray-500);
      min-width: 0;
    }

    .session-title {
      margin: 0;
      font-size: 1rem;
      line-height: 1.35;
      font-weight: 650;
      color: var(--gray-900);
      overflow-wrap: anywhere;
    }

    .session-snippet {
      margin: 8px 0 0;
      color: var(--gray-700);
      overflow-wrap: anywhere;
    }

    .session-detail {
      display: grid;
      gap: 4px;
      margin: 10px 0 0;
      color: var(--gray-600);
      font-family: var(--font-family-monospace);
      font-size: var(--font-d3);
      line-height: 1.35;
    }

    .session-detail div {
      display: grid;
      grid-template-columns: 62px minmax(0, 1fr);
      gap: 10px;
      min-width: 0;
    }

    .session-detail dt {
      color: var(--gray-500);
    }

    .session-detail dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .empty,
    .error {
      width: 100%;
      margin-top: 10px;
      padding: 18px;
      background: var(--gray-100);
      border-left: 3px solid var(--gray-400);
      border-radius: var(--border-radius);
      color: var(--gray-600);
    }

    .error {
      color: var(--orange-800);
      background: var(--orange-50);
    }

    @media (max-width: 1180px) {
      :root {
        --landing-content-width: calc(100vw - 32px);
      }

      .conversation-id {
        position: static;
        transform: none;
        flex-flow: row nowrap;
        align-items: center;
        padding: 12px 14px 0;
        align-self: flex-start;
      }

      .conversation-id a {
        padding: 0;
      }

      .rail-rule {
        margin: 0;
      }

      .rail-label {
        padding: 0;
      }
    }

    @media (max-width: 820px) {
      .header {
        align-items: stretch;
        flex-wrap: wrap;
        justify-content: flex-start;
      }

      .header input {
        order: 2;
        width: 100%;
      }

      .header select,
      .button-load {
        order: 3;
        flex: 1 1 135px;
      }

      .session-toolbar {
        padding-top: 10px;
      }

      .session-open {
        margin-left: 0;
        width: 100%;
      }

      .badge {
        font-size: 0.9375rem;
      }

      .session-detail div {
        grid-template-columns: 1fr;
        gap: 1px;
      }
    }
  </style>
</head>
<body>
  <main class="app">
    <header class="header">
      <a class="name" href="/">Euphony</a>
      <input id="filter" type="search" placeholder="Filter local Codex sessions" autocomplete="off">
      <button id="refresh" class="button-load" type="button">Load</button>
      <select id="sort">
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="size">Largest first</option>
      </select>
    </header>

    <div class="content">
      <div class="content-left" aria-hidden="true"></div>
      <section class="content-center">
        <div class="grid-header">
          <span class="count-label"><span id="count">0</span> total <span id="count-noun">conversations</span></span>
          <span id="root-label" class="root-label">Scanning local Codex session logs.</span>
        </div>

        <div id="sessions" class="session-list" aria-live="polite"></div>
      </section>
      <div class="content-right" aria-hidden="true"></div>
    </div>
  </main>

  <script>
    const state = { sessions: [], query: "", sort: "newest" };
    const sessionsElement = document.querySelector("#sessions");
    const countElement = document.querySelector("#count");
    const countNounElement = document.querySelector("#count-noun");
    const rootLabel = document.querySelector("#root-label");

    function formatDate(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "Unknown date";
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(date);
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return "";
      const units = ["B", "KB", "MB", "GB"];
      let value = bytes;
      let index = 0;
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
      }
      return value.toFixed(index === 0 ? 0 : 1) + " " + units[index];
    }

    function shortSessionID(session) {
      const value = String(session.id || session.filename || session.relativePath || "").replace(/\\.jsonl$/, "");
      if (!value) return "unknown";
      return value.length > 8 ? value.slice(0, 8) : value;
    }

    function compactPath(value) {
      const text = String(value || "");
      if (text.length <= 110) return text;
      const parts = text.split(/[\\\\/]/).filter(Boolean);
      if (parts.length >= 3) return ".../" + parts.slice(-3).join("/");
      return "..." + text.slice(-107);
    }

    function euphonyURL(session) {
      const sessionURL = new URL("/session/" + session.token + ".jsonl", window.location.origin).toString();
      const url = new URL("/euphony/", window.location.origin);
      url.searchParams.set("path", sessionURL);
      url.searchParams.set("frontend-only", "true");
      return url.toString();
    }

    function applyFilter() {
      const query = state.query.trim().toLowerCase();
      let rows = state.sessions.slice();
      if (query) {
        rows = rows.filter(session => [
          session.title,
          session.snippet,
          session.cwd,
          session.model,
          session.filename,
          session.relativePath,
          session.id
        ].filter(Boolean).join(" ").toLowerCase().includes(query));
      }

      rows.sort((a, b) => {
        if (state.sort === "oldest") {
          return Date.parse(a.startedAt || a.modifiedAt) - Date.parse(b.startedAt || b.modifiedAt);
        }
        if (state.sort === "size") {
          return b.sizeBytes - a.sizeBytes;
        }
        return Date.parse(b.startedAt || b.modifiedAt) - Date.parse(a.startedAt || a.modifiedAt);
      });
      return rows;
    }

    function renderBadge(className, text) {
      if (!text) return "";
      return '<span class="badge ' + className + '">' + escapeHTML(text) + '</span>';
    }

    function renderDetail(label, value, title) {
      if (!value) return "";
      const attr = title ? ' title="' + escapeHTML(title) + '"' : "";
      return '<div><dt>' + escapeHTML(label) + '</dt><dd' + attr + '>' + escapeHTML(value) + '</dd></div>';
    }

    function render() {
      const rows = applyFilter();
      countElement.textContent = rows.length.toLocaleString();
      countNounElement.textContent = rows.length === 1 ? "conversation" : "conversations";

      if (!rows.length) {
        sessionsElement.innerHTML = '<div class="empty">No matching Codex sessions found.</div>';
        return;
      }

      sessionsElement.innerHTML = rows.map(function (session, index) {
        const url = euphonyURL(session);
        const started = formatDate(session.startedAt || session.modifiedAt);
        const details =
          renderDetail("cwd", compactPath(session.cwd), session.cwd) +
          renderDetail("file", compactPath(session.relativePath), session.relativePath) +
          renderDetail("started", started);
        const badges =
          renderBadge("session-pill", "Session: " + shortSessionID(session)) +
          renderBadge("model-pill", session.model ? "Model: " + session.model : "") +
          renderBadge("cli-pill", session.cliVersion ? "CLI: " + session.cliVersion : "") +
          renderBadge("size-pill", formatBytes(session.sizeBytes));

        return '' +
          '<article class="conversation-container" tabindex="0" data-href="' + escapeHTML(url) + '">' +
            '<div class="conversation-id">' +
              '<a href="' + escapeHTML(url) + '">#' + index + '</a>' +
              '<span class="rail-rule" aria-hidden="true"></span>' +
              '<span class="rail-label">CODEX</span>' +
            '</div>' +
            '<div class="session-toolbar">' +
              badges +
              '<a class="button session-open" href="' + escapeHTML(url) + '">Open</a>' +
            '</div>' +
            '<div class="session-preview">' +
              '<h2 class="session-title">' + escapeHTML(session.title || session.filename) + '</h2>' +
              (session.snippet ? '<p class="session-snippet">' + escapeHTML(session.snippet) + '</p>' : '') +
              '<dl class="session-detail">' + details + '</dl>' +
            '</div>' +
          '</article>';
      }).join("");
    }

    function escapeHTML(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    async function loadSessions() {
      sessionsElement.innerHTML = '<div class="empty">Scanning sessions...</div>';
      try {
        const response = await fetch("/api/sessions", { cache: "no-store" });
        if (!response.ok) throw new Error(await response.text());
        const payload = await response.json();
        state.sessions = payload.sessions || [];
        rootLabel.textContent = payload.sessionsRoot
          ? payload.sessionsRoot + " (" + Number(payload.totalDiscovered || state.sessions.length).toLocaleString() + " discovered)"
          : "Local Codex sessions";
        render();
      } catch (error) {
        sessionsElement.innerHTML = '<div class="error">' + escapeHTML(error.message || String(error)) + '</div>';
      }
    }

    document.querySelector("#filter").addEventListener("input", event => {
      state.query = event.target.value;
      render();
    });
    document.querySelector("#sort").addEventListener("change", event => {
      state.sort = event.target.value;
      render();
    });
    document.querySelector("#refresh").addEventListener("click", loadSessions);
    sessionsElement.addEventListener("click", event => {
      if (event.target.closest("a, button, input, select")) return;
      const card = event.target.closest(".conversation-container[data-href]");
      if (card) window.location.href = card.dataset.href;
    });
    sessionsElement.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const card = event.target.closest(".conversation-container[data-href]");
      if (!card) return;
      event.preventDefault();
      window.location.href = card.dataset.href;
    });
    loadSessions();
  </script>
</body>
</html>`
}

async function handleRequest(req, res, options) {
  const requestURL = new URL(req.url, `http://${req.headers.host || `${options.host}:${options.port}`}`)
  const pathname = requestURL.pathname

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    })
    res.end()
    return
  }

  if (req.method !== "GET") {
    await sendText(res, 405, "Method not allowed")
    return
  }

  if (pathname === "/health") {
    await sendJSON(res, { ok: true })
  } else if (pathname === "/api/sessions") {
    await sendJSON(res, await scanSessions(options.codexRoot))
  } else if (pathname.startsWith("/session/")) {
    await serveSession(req, res, options.codexRoot, pathname)
  } else if (pathname === "/euphony" || pathname.startsWith("/euphony/")) {
    await serveEuphony(res, pathname)
  } else if (pathname === "/" || pathname === "/index.html") {
    const html = renderIndexHTML()
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
      "Cache-Control": "no-store"
    })
    res.end(html)
  } else {
    await sendText(res, 404, "Not found")
  }
}

function startServer(options) {
  const server = http.createServer((req, res) => {
    handleRequest(req, res, options).catch(error => {
      console.error(error)
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
      }
      res.end("Internal server error")
    })
  })

  server.listen(options.port, options.host, () => {
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : options.port
    console.log(`Euphony Codex session browser running at http://${options.host}:${port}`)
  })

  return server
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2))
  startServer(options)
}

module.exports = {
  parseArgs,
  renderIndexHTML,
  resolveSessionPath,
  scanSessions,
  startServer
}
