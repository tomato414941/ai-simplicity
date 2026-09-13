const messagesElement = document.querySelector("#messages");
const form = document.querySelector("#composer");
const input = document.querySelector("#message-input");
const submitButton = form.querySelector("button");
const statusElement = document.querySelector("#reply-status");
const statusText = document.querySelector("#status-text");
const statusIndicator = document.querySelector("#status-indicator");
const statusAction = document.querySelector("#status-action");
const PENDING_KEY = "ai-simplicity.pending";
const DRAFT_KEY = "ai-simplicity.draft";
const RECOVERY_WINDOW_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;
const articles = new Map();

let snapshot = { messages: [], pending: null, observation: "current" };
let outbox = readSavedPending();
let loading = true;
let busy = false;
let connected = false;
let unavailableSince = null;
let notice = "";
let action = "check";
let timer;

try { input.value = localStorage.getItem(DRAFT_KEY) ?? ""; } catch {}
resizeInput();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || busy || loading || !connected || snapshot.pending || outbox) return;
  const pending = {
    id: crypto.randomUUID(), text, createdAt: new Date().toISOString(),
    partialText: "", status: "processing", error: null,
  };
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    notice = "この端末に入力を保存できないため、送信していません。";
    render();
    return;
  }
  outbox = pending;
  input.value = "";
  saveDraft();
  resizeInput();
  void post("/api/messages", { id: pending.id, text });
});

statusAction.addEventListener("click", () => {
  if (busy) return;
  if (action === "retry") void post("/api/retry", { id: snapshot.pending.id });
  else if (action === "send") void post("/api/messages", { id: outbox.id, text: outbox.text });
  else {
    unavailableSince = Date.now();
    void check();
  }
});

input.addEventListener("input", () => { resizeInput(); saveDraft(); });
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

await check();
input.focus();

async function post(url, body) {
  clearTimeout(timer);
  busy = true;
  unavailableSince = null;
  notice = "";
  render();
  try {
    applySnapshot(await request(url, { method: "POST", body: JSON.stringify(body) }));
  } catch (error) {
    connected = false;
    unavailableSince ??= Date.now();
    if (error.status >= 400 && error.status < 500 && url === "/api/messages" && !snapshot.pending) {
      // A definite rejection is not an ambiguous delivery failure.
      input.value = outbox.text;
      outbox = null;
      savePending();
      saveDraft();
      resizeInput();
      notice = "送れませんでした。入力を残してあります。";
    }
  } finally {
    busy = false;
  }
  await check();
}

async function check() {
  clearTimeout(timer);
  const remaining = recoveryRemaining();
  if (remaining <= 0) { render(); return; }
  busy = true;
  render();
  try {
    applySnapshot(await request("/api/messages", {
      signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
    }));
  } catch {
    connected = false;
    unavailableSince ??= Date.now();
  } finally {
    busy = false;
  }

  const pending = snapshot.pending ?? outbox;
  const needsCheck = unavailableSince !== null || Boolean(pending && pending.status !== "failed");
  render();
  if (needsCheck && recoveryRemaining() > 0) timer = setTimeout(check, Math.min(POLL_INTERVAL_MS, recoveryRemaining()));
}

function recoveryRemaining() {
  return unavailableSince === null ? Infinity : Math.max(0, RECOVERY_WINDOW_MS - (Date.now() - unavailableSince));
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json" },
    signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw Object.assign(new Error("Request failed"), { status: response.status });
  return response.json();
}

function applySnapshot(next) {
  snapshot = next;
  connected = true;
  loading = false;
  if (outbox && next.messages.some((message) => message.id === outbox.id)) outbox = null;
  if (next.pending) {
    if (outbox && outbox.id !== next.pending.id) {
      input.value = [outbox.text, input.value].filter(Boolean).join("\n\n");
      saveDraft();
      resizeInput();
    }
    outbox = { ...next.pending };
  }
  const unavailable = next.observation === "unavailable" || Boolean(outbox && !next.pending);
  unavailableSince = unavailable ? (unavailableSince ?? Date.now()) : null;
  savePending();
}

function render() {
  const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 180;
  const visible = [...snapshot.messages];
  const pending = snapshot.pending ?? outbox;
  if (pending) {
    visible.push({ id: pending.id, role: "user", text: pending.text });
    if (pending.partialText) visible.push({ id: `${pending.id}:reply`, role: "assistant", text: pending.partialText });
  }
  const ids = new Set(visible.map((message) => message.id));
  for (const [id, article] of articles) {
    if (!ids.has(id)) { article.remove(); articles.delete(id); }
  }
  for (const message of visible) {
    let article = articles.get(message.id);
    if (!article) {
      article = document.createElement("article");
      article.className = `message ${message.role}`;
      article.append(document.createElement("p"));
      messagesElement.insertBefore(article, statusElement);
      articles.set(message.id, article);
    }
    const paragraph = article.querySelector("p");
    if (paragraph.textContent !== message.text) paragraph.textContent = message.text;
  }

  let label = notice;
  let button = "";
  action = "check";
  if (unavailableSince !== null) {
    label = pending ? "返答の状態を確認しています" : "会話を読み込んでいます";
    if (recoveryRemaining() === 0) {
      label = pending ? "今は返答を確認できません。入力は保存されています。" : "今は会話を読み込めません。";
      button = "もう一度確認";
      if (connected && outbox && !snapshot.pending) {
        label = "送信を確認できませんでした。入力はこの端末に保存されています。";
        button = "もう一度送信";
        action = "send";
      }
    }
  } else if (snapshot.pending?.status === "failed") {
    label = pending.error;
    button = "再試行";
    action = "retry";
  } else if (pending) {
    label = "返答を待っています";
  } else if (loading) {
    label = "会話を読み込んでいます";
  }
  statusElement.hidden = !label;
  statusText.textContent = label;
  statusIndicator.hidden = Boolean(button || notice || !label);
  statusAction.hidden = !button;
  statusAction.textContent = button;
  statusAction.disabled = busy;
  submitButton.disabled = busy || loading || Boolean(pending) || !connected;
  if (nearBottom) requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" }));
}

function readSavedPending() {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_KEY));
    if (value && typeof value.id === "string" && typeof value.text === "string") return value;
  } catch {}
  return null;
}

function savePending() {
  try {
    if (outbox) localStorage.setItem(PENDING_KEY, JSON.stringify(outbox));
    else localStorage.removeItem(PENDING_KEY);
  } catch {}
}

function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, input.value); } catch {}
}

function resizeInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}
