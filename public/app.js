import { SessionState, isTerminal, itemText, readEvents } from "./agent-session.js";

const messagesElement = document.querySelector("#messages");
const form = document.querySelector("#composer");
const input = document.querySelector("#message-input");
const composerButton = form.querySelector("button");
const composerIcon = composerButton.querySelector("path");
const statusElement = document.querySelector("#reply-status");
const statusText = document.querySelector("#status-text");
const statusIndicator = document.querySelector("#status-indicator");
const statusAction = document.querySelector("#status-action");
const DRAFT_KEY = "ai-simplicity.draft";
const SUBMISSION_KEY = "ai-simplicity.input-event";
const VIEW_KEY = "ai-simplicity.session-items";
const STOP_KEY = "ai-simplicity.cancel-turn";
const RECOVERY_WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const state = new SessionState();
const articles = new Map();
let submission = readSaved(SUBMISSION_KEY);
let stopping = readSaved(STOP_KEY);
let stopErrorTurnId = null;
let connection = null;
let connected = false;
let operation = null;
let unavailableSince = null;
let recoveryAttempt = 0;
let recoveryTimer;
let notice = "";
let action = "check";

const cached = readSaved(VIEW_KEY);
if (cached?.session && Array.isArray(cached.items) && Array.isArray(cached.turns)) {
  state.restore(cached.session, cached.items, cached.turns);
}
if (!submission?.events?.length || typeof submission.idempotency_key !== "string") submission = null;
try { input.value = localStorage.getItem(DRAFT_KEY) ?? ""; } catch {}
resizeInput();
renderHistory();
render();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || operation || !connected || activeTurn() || submission) return;
  sendMessage(text);
});
composerButton.addEventListener("click", () => {
  if (!operation && activeTurn() && !stopping) void stop();
});
statusAction.addEventListener("click", () => {
  if (operation) return;
  if (action === "send") void submit();
  else if (action === "retry") {
    const item = [...state.items.values()].find((item) => item.role === "user" && item.turn_id === state.latestTurn?.id);
    if (item) sendMessage(itemText(item));
  } else {
    unavailableSince = null;
    recoveryAttempt = 0;
    void connect();
  }
});
input.addEventListener("input", () => { resizeInput(); saveDraft(); });
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!activeTurn() && !submission) form.requestSubmit();
  }
});
window.addEventListener("pagehide", () => {
  saveView();
  const previous = connection;
  connection = null;
  previous?.controller.abort();
  clearTimeout(recoveryTimer);
});
window.addEventListener("pageshow", (event) => { if (event.persisted) void connect(); });
window.addEventListener("online", () => { if (!connected) { unavailableSince = null; void connect(); } });
window.addEventListener("offline", () => recover(connection));

await connect();
input.focus();

function activeTurn() {
  const turn = state.latestTurn;
  return turn && !isTerminal(turn) ? turn : null;
}
function base() { return `/v1/agents/sessions/${state.session.id}`; }
function recoveryRemaining() {
  return unavailableSince === null ? Infinity : Math.max(0, RECOVERY_WINDOW_MS - (Date.now() - unavailableSince));
}

async function jsonRequest(url, options = {}, signal) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", "OpenAI-Beta": "agents=v1", ...options.headers },
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(signal ? Math.max(1, Math.min(REQUEST_TIMEOUT_MS, recoveryRemaining())) : REQUEST_TIMEOUT_MS)]),
  });
  if (!response.ok) throw Object.assign(new Error("Request failed."), { status: response.status });
  return response.status === 204 ? null : response.json();
}

async function allPages(path, signal) {
  const data = [];
  let after;
  do {
    const query = new URLSearchParams({ order: "asc", limit: "100", ...(after ? { after } : {}) });
    const page = await jsonRequest(`${path}?${query}`, {}, signal);
    data.push(...page.data);
    if (!page.has_more) return data;
    if (!page.last_id || page.last_id === after) throw new Error("Invalid pagination cursor.");
    after = page.last_id;
  } while (true);
}

async function connect() {
  clearTimeout(recoveryTimer);
  const previous = connection;
  const current = { controller: new AbortController(), ready: false, buffer: [], syncing: null };
  connection = current;
  previous?.controller.abort();
  connected = false;
  render();
  try {
    if (!state.session) {
      const page = await jsonRequest("/v1/agents/sessions?limit=1", {}, current.controller.signal);
      if (!page.data[0]) throw new Error("No session is available.");
      state.session = page.data[0];
    }
    // Only opening the HTTP connection has a deadline. The SSE body has none.
    const opening = setTimeout(() => current.controller.abort(), Math.min(REQUEST_TIMEOUT_MS, recoveryRemaining()));
    let response;
    try {
      response = await fetch(`${base()}/events`, {
        headers: { Accept: "text/event-stream", "OpenAI-Beta": "agents=v1" }, signal: current.controller.signal,
      });
    } finally { clearTimeout(opening); }
    if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
      throw new Error("Could not open the event stream.");
    }
    // Start reading before fetching history: events during restoration are buffered.
    void consume(current, response.body);
    await synchronize(current);
    if (connection !== current || current.controller.signal.aborted) return;
    connected = true;
    unavailableSince = null;
    recoveryAttempt = 0;
    render();
  } catch { recover(current); }
}

async function consume(current, body) {
  try {
    for await (const event of readEvents(body)) {
      if (connection !== current || current.controller.signal.aborted) return;
      if (!current.ready) current.buffer.push(event);
      else handleEvent(event, current);
    }
    if (connection === current) recover(current);
  } catch { if (connection === current) recover(current); }
}

async function synchronize(current) {
  if (current.syncing) return current.syncing;
  current.ready = false;
  current.syncing = (async () => {
    const [session, items, turns] = await Promise.all([
      jsonRequest(base(), {}, current.controller.signal),
      allPages(`${base()}/items`, current.controller.signal),
      allPages(`${base()}/turns`, current.controller.signal),
    ]);
    if (connection !== current || current.controller.signal.aborted) return;
    state.restore(session, items, turns);
    current.ready = true;
    for (const event of current.buffer.splice(0)) handleEvent(event, current, true);
    settleSubmission();
    settleStop();
    renderHistory();
    render();
    saveView();
  })();
  try { await current.syncing; }
  finally { current.syncing = null; }
}

function handleEvent(event, current, restoring = false) {
  state.apply(event);
  if (event.type === "error") throw new Error("The event stream needs recovery.");
  if (event.type === "agent.session.environment.failed") notice = "今は返答を続けられません。";
  if (event.turn?.subagent_id == null && event.turn && submission && isNewTurn(event.turn.id) && !submission.turn_id) {
    submission.turn_id = event.turn.id;
    saveSubmission();
  }
  settleStop();
  if (event.item || (event.turn && isTerminal(event.turn))) renderHistory();
  else if (event.item_id) renderItem(event.item_id, state.items.get(event.item_id));
  render();
  if (!restoring && ((event.turn?.subagent_id == null && event.turn && isTerminal(event.turn)) || ["agent.session.failed", "agent.session.environment.failed", "agent.session.requires_action"].includes(event.type))) {
    void synchronize(current).catch(() => recover(current));
  }
}

function recover(current) {
  if (current !== connection) return;
  connection = null;
  current?.controller.abort();
  connected = false;
  unavailableSince ??= Date.now();
  saveView();
  clearTimeout(recoveryTimer);
  const remaining = recoveryRemaining();
  if (remaining > 0) {
    const delay = Math.min(1_000 * 2 ** recoveryAttempt++, 8_000, remaining);
    recoveryTimer = setTimeout(() => {
      if (recoveryRemaining() > 0) void connect();
      else render();
    }, delay);
  }
  render();
}

function sendMessage(text) {
  const next = {
    session_id: state.session.id, idempotency_key: crypto.randomUUID(), acknowledged: false,
    previous_turn_id: state.latestTurn?.id ?? null, turn_id: null,
    events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text }] }] }],
  };
  try { localStorage.setItem(SUBMISSION_KEY, JSON.stringify(next)); }
  catch { notice = "この端末に入力を保存できないため、送信していません。"; render(); return; }
  submission = next;
  input.value = "";
  saveDraft();
  resizeInput();
  renderHistory();
  void submit();
}

async function submit() {
  if (!submission || submission.session_id !== state.session.id) return;
  operation = "send";
  notice = "";
  render();
  try {
    await jsonRequest(`${base()}/events`, {
      method: "POST", headers: { "Idempotency-Key": submission.idempotency_key }, body: JSON.stringify({ events: submission.events }),
    });
    submission.acknowledged = true;
    saveSubmission();
    settleSubmission();
  } catch (error) {
    if ([400, 401, 403, 404, 413, 415, 422, 429].includes(error.status)) {
      input.value = [itemText(submission.events[0].input[0]), input.value].filter(Boolean).join("\n\n");
      submission = null;
      saveSubmission();
      saveDraft();
      resizeInput();
      notice = "送れませんでした。入力を残してあります。";
    } else {
      // Delivery is unknown. Recovery only reads; a resend is explicit and uses
      // the same native Idempotency-Key, never a newly generated request.
      recover(connection);
    }
  } finally {
    operation = null;
    renderHistory();
    render();
  }
}

async function stop() {
  const turn = activeTurn();
  if (!turn) return;
  operation = "stop";
  stopErrorTurnId = null;
  stopping = { session_id: state.session.id, turn_id: turn.id };
  writeSaved(STOP_KEY, stopping);
  notice = "";
  render();
  try {
    await jsonRequest(`${base()}/events`, {
      method: "POST", body: JSON.stringify({ events: [{ type: "agent.session.input.cancel" }] }),
    });
    // 204 confirms acceptance, not cancellation. Only a turn event/read does that.
    if (!connected) { unavailableSince = null; recoveryAttempt = 0; void connect(); }
  } catch {
    stopping = null;
    writeSaved(STOP_KEY, null);
    stopErrorTurnId = turn.id;
    recover(connection);
  } finally { operation = null; settleStop(); render(); }
}

function settleSubmission() {
  if (!submission?.acknowledged) return;
  if ([...state.items.values()].some(matchesSubmission)) {
    submission = null;
    saveSubmission();
  }
}
function matchesSubmission(item) {
  return submission && item.type === "message" && item.role === "user"
    && isNewTurn(item.turn_id)
    && (!submission.turn_id || item.turn_id === submission.turn_id)
    && itemText(item) === itemText(submission.events[0].input[0]);
}
function isNewTurn(id) {
  const ids = [...state.turns.keys()];
  return ids.indexOf(id) > ids.indexOf(submission.previous_turn_id);
}
function settleStop() {
  if (stopping && (isTerminal(state.turns.get(stopping.turn_id)) || stopping.session_id !== state.session?.id)) {
    stopping = null;
    writeSaved(STOP_KEY, null);
  }
}

function renderHistory() {
  const visible = [...state.items].filter(([, item]) => item.type === "message" && item.phase !== "commentary");
  if (submission && !visible.some(([, item]) => matchesSubmission(item))) {
    const entry = ["input-event", submission.events[0].input[0]];
    const index = visible.findIndex(([, item]) => item.turn_id === submission.turn_id);
    visible.splice(index < 0 ? visible.length : index, 0, entry);
  }
  for (const turn of state.turns.values()) {
    if (!["cancelled", "failed"].includes(turn.status) || turn.subagent_id != null) continue;
    const index = visible.findLastIndex(([, item]) => item.turn_id === turn.id);
    if (index >= 0 && visible[index][1].role === "assistant") continue;
    visible.splice(index < 0 ? visible.length : index + 1, 0, [`ending:${turn.id}`, { role: "assistant", turn_id: turn.id }]);
  }
  const ids = new Set(visible.map(([id]) => id));
  for (const [id, article] of articles) if (!ids.has(id)) { article.remove(); articles.delete(id); }
  for (const [id, item] of visible) {
    renderItem(id, item);
    messagesElement.insertBefore(articles.get(id), statusElement);
  }
}

function renderItem(id, item) {
  if (!item || !["user", "assistant"].includes(item.role) || item.phase === "commentary") return;
  const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 180;
  let article = articles.get(id);
  if (!article) {
    article = document.createElement("article");
    article.className = `message ${item.role}`;
    article.append(document.createElement("p"));
    const ending = document.createElement("small");
    ending.className = "message-ending";
    article.append(ending);
    messagesElement.insertBefore(article, statusElement);
    articles.set(id, article);
  }
  const text = itemText(item);
  const paragraph = article.querySelector("p");
  if (paragraph.textContent !== text) paragraph.textContent = text;
  paragraph.hidden = !text;
  const status = state.turns.get(item.turn_id)?.status;
  const ending = article.querySelector("small");
  ending.textContent = item.role === "assistant" ? (status === "cancelled" ? "停止しました" : status === "failed" ? "返答を作れませんでした" : "") : "";
  ending.hidden = !ending.textContent;
  if (nearBottom) requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" }));
}

function render() {
  const turn = state.latestTurn;
  const stopError = stopErrorTurnId === turn?.id && !isTerminal(turn) ? "停止を確認できませんでした。もう一度お試しください。" : "";
  const generating = Boolean(activeTurn() || submission);
  let label = notice || stopError, button = "";
  action = "check";
  if (unavailableSince !== null) {
    label = stopping ? "停止の状態を確認しています" : generating ? "返答の状態を確認しています" : "会話を読み込んでいます";
    if (recoveryRemaining() === 0) {
      label = stopping ? "今は停止を確認できません。" : generating ? "今は返答を確認できません。入力は保存されています。" : "今は会話を読み込めません。";
      button = "もう一度確認";
    }
  } else if (!connected) label = "会話を読み込んでいます";
  else if (state.session?.status === "failed") {
    label = "今は会話を続けられません。";
    button = "もう一度確認";
  }
  else if (submission && !submission.acknowledged && !operation) {
    label = "送信を確認できませんでした。入力はこの端末に保存されています。";
    button = "もう一度送信";
    action = "send";
  } else if (generating) label = stopping ? "停止しています" : notice || stopError || (activeTurn()?.status === "waiting" || state.session?.status === "requires_action" ? "返答が一時停止しています。" : "返答を待っています");
  else if (turn?.status === "failed" && !notice) {
    label = turn.error?.code === "credit_balance_exhausted" ? "今は返答を作れません。" : "返答を作れませんでした。";
    if ([...state.items.values()].some((item) => item.role === "user" && item.turn_id === turn.id)) {
      button = "再試行";
      action = "retry";
    }
  } else if (state.session?.status === "requires_action" || state.session?.status === "failed") {
    label = "今は会話を続けられません。";
    button = "もう一度確認";
  }
  statusElement.hidden = !label;
  statusText.textContent = label;
  statusIndicator.hidden = Boolean(button || notice || stopError || !label);
  statusAction.hidden = !button;
  statusAction.textContent = button;
  statusAction.disabled = Boolean(operation);
  const buttonLabel = generating ? (stopping ? "停止中" : "停止") : "送る";
  composerButton.type = generating ? "button" : "submit";
  composerButton.setAttribute("aria-label", buttonLabel);
  composerButton.setAttribute("title", buttonLabel);
  composerIcon.setAttribute("d", generating ? "M8 8h8v8H8z" : "M5 12h13m-5-5 5 5-5 5");
  composerIcon.setAttribute("fill", generating ? "currentColor" : "none");
  composerButton.disabled = Boolean(operation) || (generating ? !activeTurn() || Boolean(stopping) : !connected || state.session?.status === "failed");
}

function readSaved(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function writeSaved(key, value) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch {} }
function saveSubmission() { writeSaved(SUBMISSION_KEY, submission); }
function saveView() {
  if (state.session) writeSaved(VIEW_KEY, { session: state.session, items: [...state.items.values()], turns: [...state.turns.values()] });
}
function saveDraft() { try { localStorage.setItem(DRAFT_KEY, input.value); } catch {} }
function resizeInput() { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; }
