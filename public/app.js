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
const articles = new Map();

let snapshot = { messages: [], pending: null };
let outbox = readSavedPending();
let loading = true;
let busy = false;
let paused = false;
let connectionFailed = false;
let unaccepted = false;
let notice = "";
let action = "check";
let deadline = 0;
let timer;

try { input.value = localStorage.getItem(DRAFT_KEY) ?? ""; } catch {}
resizeInput();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || busy || loading || snapshot.pending || outbox) return;
  const pending = {
    id: crypto.randomUUID(), text, createdAt: new Date().toISOString(),
    partialText: "", status: "waiting", error: null,
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
  else void startChecking();
});

input.addEventListener("input", () => { resizeInput(); saveDraft(); });
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

await startChecking();
input.focus();

async function post(url, body) {
  clearTimeout(timer);
  busy = true;
  paused = false;
  notice = "";
  render();
  try {
    applySnapshot(await request(url, { method: "POST", body: JSON.stringify(body) }));
  } catch (error) {
    connectionFailed = true;
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
  await startChecking();
}

async function startChecking() {
  clearTimeout(timer);
  deadline = Date.now() + 60_000;
  paused = false;
  await check();
}

async function check() {
  busy = true;
  render();
  try {
    applySnapshot(await request("/api/messages"));
    loading = false;
    connectionFailed = false;
  } catch {
    connectionFailed = true;
  } finally {
    busy = false;
  }

  const pending = snapshot.pending ?? outbox;
  const needsCheck = connectionFailed || loading || Boolean(pending && snapshot.pending?.status !== "failed");
  paused = needsCheck && Date.now() >= deadline;
  render();
  if (needsCheck && !paused) timer = setTimeout(check, 2_000);
}

async function request(url, options = {}) {
  const timeout = !options.method && deadline ? Math.max(1, Math.min(10_000, deadline - Date.now())) : 10_000;
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw Object.assign(new Error("Request failed"), { status: response.status });
  return response.json();
}

function applySnapshot(next) {
  snapshot = next;
  if (outbox && next.messages.some((message) => message.id === outbox.id)) outbox = null;
  if (next.pending) {
    if (outbox && outbox.id !== next.pending.id) {
      input.value = [outbox.text, input.value].filter(Boolean).join("\n\n");
      saveDraft();
      resizeInput();
    }
    outbox = { ...next.pending };
  }
  unaccepted = Boolean(outbox && !next.pending);
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
  if (snapshot.pending?.status === "failed") {
    label = pending.error;
    button = "再試行";
    action = "retry";
  } else if (paused) {
    label = pending ? "今は返答を確認できません。入力は保存されています。" : "今は会話を読み込めません。";
    if (snapshot.pending?.status === "waiting" && !connectionFailed) label = "返答に時間がかかっています。あとで戻って確認できます。";
    button = "もう一度確認";
    if (unaccepted) {
      label = "送信を確認できませんでした。入力はこの端末に保存されています。";
      button = "もう一度送信";
      action = "send";
    }
  } else if (pending) {
    const elapsed = Date.now() - Date.parse(pending.createdAt);
    label = elapsed < 3_000 || (pending.status === "waiting" && !connectionFailed)
      ? "返答を待っています" : "返答の状態を確認しています";
  } else if (loading || connectionFailed) {
    label = "会話を読み込んでいます";
  }
  statusElement.hidden = !label;
  statusText.textContent = label;
  statusIndicator.hidden = Boolean(button || notice || !label);
  statusAction.hidden = !button;
  statusAction.textContent = button;
  statusAction.disabled = busy;
  submitButton.disabled = busy || loading || Boolean(pending) || connectionFailed;
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
