import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { SessionState, isTerminal, itemText, readEvents } from "../public/agent-session.js";
import { session, turn, item, userItem, page, turnEvent, USER_A, USER_B } from "./helpers.js";

const script = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/^import .*\n/gm, "");
const SUBMISSION_KEY = `ai-simplicity.${USER_A}.input-event`;
const DRAFT_KEY = `ai-simplicity.${USER_A}.draft`;

// Executes the shipped UI using a small DOM and deterministic clock. No browser automation.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.handlers = {}; this.attributes = {}; this.style = {}; this.value = ""; this.scrollHeight = 40; }
  append(node) { node.parent = this; this.children.push(node); }
  insertBefore(node, reference) {
    if (node.parent) node.remove();
    node.parent = this;
    this.children.splice(this.children.indexOf(reference), 0, node);
  }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  querySelector(tag) { return this.children.find((node) => node.tag === tag) ?? this.children.map((node) => node.querySelector(tag)).find(Boolean); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(type, callback) { this.handlers[type] = callback; }
  focus() { this.focused = true; }
  requestSubmit() { this.handlers.submit({ preventDefault() {} }); }
  set textContent(value) { this.text = value; }
  get textContent() { return this.text ?? this.children.map((node) => node.textContent).join(""); }
}

async function boot(t, options = {}) {
  const remote = { session: session(), items: [], turns: [], online: true, loseSendResponse: false, ...options.remote };
  const saved = options.saved ?? new Map();
  const elements = Object.fromEntries(["messages", "composer", "message-input", "reply-status", "status-text", "status-indicator", "status-action"].map((id) => [id, new Element(id)]));
  const button = new Element("button"), svg = new Element("svg");
  svg.append(new Element("path")); button.append(svg); elements.composer.append(button); elements.messages.append(elements["reply-status"]);
  const timers = new Map(), requests = [], streams = [], windowEvents = {}, accepted = new Set();
  let time = 100_000, timerId = 0, eventId = 0, uuid = 0, writes = 0;
  let authChanged, accountOptions;
  let authSession = options.authSession ?? { user: { id: USER_A, is_anonymous: true }, access_token: "user-a-token" };
  const auth = {
    getSession: async () => ({ data: { session: authSession } }),
    getUser: async () => ({ data: { user: authSession.user } }),
    onAuthStateChange: (callback) => { authChanged = callback; },
    signInAnonymously: async () => ({ data: { session: authSession } }),
    ...options.auth,
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  const emit = (event) => { for (const stream of streams) if (!stream.closed) stream.output.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ event_id: `evt_${++eventId}`, ...event })}\n\n`)); };
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const context = {
    SessionState, isTerminal, itemText, readEvents, URLSearchParams, queueMicrotask,
    openAuth: async () => ({ auth, sessionDefaults: { agent: { model: "gpt-6-astra" }, environment: { type: "openai_hosted" } } }),
    mountAccount: (value) => { accountOptions = value; return { render() {} }; },
    document: { querySelector: (selector) => elements[selector.slice(1)], createElement: (tag) => new Element(tag), documentElement: { scrollHeight: 1000 } },
    window: { innerHeight: 1000, scrollY: 0, scrollTo() {}, matchMedia: () => ({ matches: options.mobile ?? false }), addEventListener: (name, callback) => { windowEvents[name] = callback; } },
    localStorage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => { if (options.storageFails) throw new Error("Unavailable storage"); saved.set(key, value); writes++; }, removeItem: (key) => saved.delete(key) },
    crypto: { randomUUID: () => `input_${++uuid}` }, Date: Clock, AbortSignal, AbortController,
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, at: time + delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (path, fetchOptions = {}) => {
      const url = new URL(path, "http://app.test");
      const request = { path, method: fetchOptions.method ?? "GET", body: fetchOptions.body ? JSON.parse(fetchOptions.body) : null, headers: new Headers(fetchOptions.headers) };
      requests.push(request);
      if (!remote.online) throw new Error("Offline");
      const override = await options.fetch?.(request, { remote, emit, streams });
      if (override) return override;
      if (request.method === "POST") {
        if (url.pathname === "/v1/agents/sessions") {
          remote.session = session();
          return Response.json(remote.session);
        }
        if (request.body.events[0].type === "agent.session.input.message") {
          const key = request.headers.get("idempotency-key");
          if (!accepted.has(key)) {
            accepted.add(key);
            let next = remote.turns.findLast((value) => !isTerminal(value));
            if (!next) {
              next = turn({ id: `turn_${remote.turns.length + 1}`, created_at: remote.turns.length + 1 });
              remote.turns.push(next);
              emit({ ...turnEvent(next), event_id: `created_${next.id}` });
            }
            remote.session.status = "in_progress";
            const text = itemText(request.body.events[0].input[0]);
            const inputItem = userItem(text, { id: `user_${remote.items.length + 1}`, turn_id: next.id });
            remote.items.push(inputItem);
            emit({ type: "agent.session.turn.item.done", item: inputItem });
          }
          if (remote.loseSendResponse) { remote.loseSendResponse = false; throw new Error("Lost send response"); }
        }
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/events")) {
        const stream = { closed: false };
        const body = new ReadableStream({
          start(controller) { stream.output = controller; },
          cancel() { stream.closed = true; },
        });
        streams.push(stream);
        fetchOptions.signal.addEventListener("abort", () => { if (!stream.closed) { stream.closed = true; stream.output.error(new Error("Aborted")); } });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname.endsWith("/items") || url.pathname.endsWith("/turns")) {
        const all = url.pathname.endsWith("/items") ? remote.items : remote.turns;
        const after = url.searchParams.get("after");
        const start = after ? all.findIndex((value) => value.id === after) + 1 : 0;
        const end = start + Number(url.searchParams.get("limit") ?? 20);
        return Response.json(page(all.slice(start, end), end < all.length));
      }
      return Response.json(url.pathname.endsWith("/sessions") ? page(remote.session ? [remote.session] : []) : remote.session);
    },
  };
  await runInNewContext(`(async () => { ${script}\n})()`, context);
  await flush();
  t.after(() => windowEvents.pagehide());
  return {
    elements, button, saved, requests, streams, remote, timers, emit, accountOptions,
    async authenticate(next, event = "SIGNED_IN") { authSession = next; authChanged(event, next); await flush(); },
    hide: () => windowEvents.pagehide(),
    get writes() { return writes; },
    text: () => elements.messages.children.filter((node) => node.tag === "article").map((node) => node.textContent),
    status: () => elements["status-text"].textContent,
    async send(text) { elements["message-input"].value = text; elements.composer.requestSubmit(); await flush(); },
    async clickAction() { elements["status-action"].handlers.click(); await flush(); },
    async clickComposer() {
      if (button.disabled) return;
      const type = button.type;
      button.handlers.click();
      if (type === "submit") elements.composer.requestSubmit();
      await flush();
    },
    async event(event) { emit(event); await flush(); },
    async disconnect() { for (const stream of streams) if (!stream.closed) { stream.closed = true; stream.output.error(new Error("Disconnected")); } await flush(); },
    async finish(status = "completed", text = "完成しました") {
      const latest = remote.turns.at(-1);
      latest.status = status; latest.completed_at = 100;
      remote.session.status = "idle";
      if (text) {
        const output = item(text, { id: `answer_${latest.id}`, turn_id: latest.id, status: status === "completed" ? "completed" : "incomplete" });
        remote.items.push(output);
        emit({ type: "agent.session.turn.item.done", item: output });
      }
      emit(turnEvent(latest));
      emit({ type: "agent.session.idle" });
      await flush();
    },
    async advance(ms) {
      const target = time + ms;
      for (let count = 0; count < 500; count++) {
        const next = [...timers].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next; time = timer.at; timers.delete(id); await timer.callback(); await flush();
        if (count === 499) assert.fail("Unexpected recurring timer");
      }
      time = target;
      await flush();
    },
  };
}

test("subscribes before reading history, consumes every page, and does not poll while reasoning", async (t) => {
  const items = Array.from({ length: 205 }, (_, n) => userItem(`text ${n}`, { id: `user_${n}` }));
  const ui = await boot(t, { remote: { items, turns: [turn()], session: session({ status: "in_progress" }) } });
  assert.equal(ui.text().length, 205);
  const paths = ui.requests.map((r) => r.path);
  assert.ok(paths.findIndex((path) => path.endsWith("/events")) < paths.findIndex((path) => path.includes("/items?")));
  assert.equal(paths.filter((path) => path.includes("/items?")).length, 3);
  const count = ui.requests.length;
  await ui.advance(10 * 60_000);
  assert.equal(ui.requests.length, count);
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.status(), "返答を待っています");
});

test("text streams into the same item without HTTP checks or persistence on each delta", async (t) => {
  const ui = await boot(t);
  await ui.send("こんにちは");
  await ui.event({ type: "agent.session.turn.item.added", item: item("", { id: "answer_turn_1" }) });
  const count = ui.requests.length, writes = ui.writes;
  for (const delta of ["こ", "ん", "に", "ちは"]) await ui.event({ type: "agent.session.turn.output_text.delta", item_id: "answer_turn_1", content_index: 0, delta });
  assert.deepEqual(ui.text(), ["こんにちは", "こんにちは"]);
  assert.equal(ui.requests.length, count);
  assert.equal(ui.writes, writes);
  await ui.finish();
  assert.deepEqual(ui.text(), ["こんにちは", "完成しました"]);
  assert.equal(ui.elements["reply-status"].hidden, true);
  assert.equal(ui.button.type, "submit");
  assert.equal(ui.saved.has(SUBMISSION_KEY), false);
});

test("a lost send response is not an excuse to generate again; explicit resend reuses the key", async (t) => {
  const ui = await boot(t, { remote: { loseSendResponse: true } });
  await ui.send("こんにちは");
  await ui.advance(1_000);
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 1);
  assert.equal(ui.remote.turns.length, 1);
  assert.deepEqual(ui.text(), ["こんにちは"]);
  assert.equal(ui.elements["status-action"].textContent, "もう一度送信");
  await ui.clickAction();
  const posts = ui.requests.filter((r) => r.method === "POST");
  assert.equal(posts[0].headers.get("idempotency-key"), posts[1].headers.get("idempotency-key"));
  assert.equal(ui.remote.turns.length, 1);
  assert.equal(ui.saved.has(SUBMISSION_KEY), false);
});

test("HTTP acceptance does not wait for a matching item or a new turn", async (t) => {
  const ui = await boot(t, { fetch: async ({ method }, { remote }) => {
    if (method !== "POST") return;
    remote.session.status = "in_progress";
    remote.turns.push(turn());
    return new Response(null, { status: 204 });
  } });
  await ui.send("まだ履歴にない入力");
  assert.equal(ui.saved.has(SUBMISSION_KEY), false);
  assert.deepEqual(ui.text(), [], "Only saved/streamed items belong in the history");
  assert.equal(ui.status(), "返答を待っています");
  assert.equal(ui.button.getAttribute("aria-label"), "停止");
  assert.equal(ui.button.disabled, false);
});

test("a stale idle view can send into a turn started by another client", async (t) => {
  const previous = turn({ status: "completed" });
  const ui = await boot(t, { remote: { turns: [previous], items: [userItem("以前の入力")] }, fetch: async ({ method }, { remote, emit }) => {
    if (method === "POST") {
      // Another client started work after the last snapshot; its turn event was missed.
      remote.turns.push(turn({ id: "turn_2" }));
      remote.session.status = "in_progress";
      const other = userItem("同じ本文", { id: "other_client_input", turn_id: "turn_2" });
      remote.items.push(other);
      emit({ type: "agent.session.turn.item.done", item: other });
    }
  } });
  await ui.send("同じ本文");
  assert.equal(ui.remote.turns.length, 2);
  assert.equal(ui.saved.has(SUBMISSION_KEY), false);
  assert.deepEqual(ui.text(), ["以前の入力", "同じ本文", "同じ本文"]);
  assert.equal(ui.status(), "返答を待っています");
});

test("a completed turn arriving before its send acknowledgment cannot strand input", async (t) => {
  const ui = await boot(t, { fetch: async ({ method }, { remote, emit }) => {
    if (method !== "POST") return;
    const completed = turn({ status: "completed" });
    remote.turns.push(completed);
    remote.items.push(item("返答", { status: "completed" }));
    emit(turnEvent(completed));
    return new Response(null, { status: 204 });
  } });
  await ui.send("入力");
  assert.equal(ui.saved.has(SUBMISSION_KEY), false);
  assert.deepEqual(ui.text(), ["返答"]);
  assert.equal(ui.button.type, "submit");
  assert.equal(ui.button.disabled, false);
});

test("a failed history read after HTTP acceptance does not turn the send into a failed submission", async (t) => {
  let accepted = false;
  const ui = await boot(t, { fetch: async ({ method, path }) => {
    if (method === "POST") accepted = true;
    if (accepted && path.includes("/items?")) return Response.json({ error: { type: "server_error", code: "internal_error" } }, { status: 503 });
  } });
  await ui.send("受け付け済み");
  assert.equal(ui.saved.has(SUBMISSION_KEY), false);
  assert.equal(ui.elements["message-input"].value, "");
  assert.equal(ui.status(), "会話を読み込んでいます", "Acceptance alone does not prove the turn is running");
  await ui.advance(60_000);
  assert.equal(ui.elements["status-action"].textContent, "もう一度確認");
  assert.equal(ui.requests.filter((request) => request.method === "POST").length, 1);
});

test("an acknowledgment after leaving the page does not reopen its stream", async (t) => {
  let acknowledge;
  const ui = await boot(t, { fetch: async ({ method }) => {
    if (method === "POST") return new Promise((resolve) => { acknowledge = resolve; });
  } });
  await ui.send("送信中に閉じる");
  assert.equal(ui.status(), "送信しています");
  assert.equal(ui.button.getAttribute("aria-label"), "送信中");
  assert.equal(ui.button.disabled, true);
  ui.hide();
  const count = ui.requests.length;
  acknowledge(new Response(null, { status: 204 }));
  await ui.advance(0);
  assert.equal(ui.saved.has(SUBMISSION_KEY), false);
  assert.equal(ui.requests.length, count);
  assert.ok(ui.streams.every((stream) => stream.closed));
});

test("a non-object error body still preserves the HTTP rejection status", async (t) => {
  const ui = await boot(t, { fetch: async ({ method }) => method === "POST" ? Response.json(null, { status: 400 }) : undefined });
  await ui.send("入力は残す");
  assert.equal(ui.saved.has(SUBMISSION_KEY), false);
  assert.equal(ui.elements["message-input"].value, "入力は残す");
  assert.equal(ui.status(), "送れませんでした。入力を残してあります。");
});

test("reloading restores an unacknowledged send without replaying it automatically", async (t) => {
  const first = await boot(t, { remote: { loseSendResponse: true } });
  await first.send("保存する入力");
  await first.advance(1_000);
  const pending = JSON.parse(first.saved.get(SUBMISSION_KEY));
  const reloaded = await boot(t, { saved: new Map(first.saved), remote: first.remote, fetch: async ({ method, headers }) => {
    if (method !== "POST") return;
    assert.equal(headers.get("idempotency-key"), pending.idempotency_key);
    return new Response(null, { status: 204 });
  } });
  assert.equal(reloaded.requests.filter((request) => request.method === "POST").length, 0);
  await reloaded.clickAction();
  assert.equal(reloaded.remote.turns.length, 1);
  assert.equal(reloaded.saved.has(SUBMISSION_KEY), false);
});

test("stop intent is transient; a reload reads the native turn without resending cancellation", async (t) => {
  const first = await boot(t);
  await first.send("こんにちは");
  await first.clickComposer();
  assert.equal(first.saved.has("ai-simplicity.cancel-turn"), false);
  const reloaded = await boot(t, { saved: new Map(first.saved), remote: first.remote });
  assert.equal(reloaded.requests.filter((request) => request.method === "POST").length, 0);
  assert.equal(reloaded.button.getAttribute("aria-label"), "停止");
  await reloaded.finish("cancelled", "");
  assert.deepEqual(reloaded.text(), ["こんにちは", "停止しました"]);
});

test("the 60-second recovery window begins at disconnection, not at input or reasoning time", async (t) => {
  const ui = await boot(t);
  await ui.send("こんにちは");
  await ui.advance(120_000);
  ui.remote.online = false;
  await ui.disconnect();
  await ui.advance(59_999);
  assert.equal(ui.elements["status-action"].hidden, true);
  await ui.advance(1);
  assert.equal(ui.elements["status-action"].textContent, "もう一度確認");
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 1);
  ui.remote.online = true;
  await ui.clickAction();
  assert.equal(ui.status(), "返答を待っています");
  const count = ui.requests.length;
  await ui.advance(300_000);
  assert.equal(ui.requests.length, count);
});

test("native stream error recovers via reads and does not mark an active turn as failed", async (t) => {
  const ui = await boot(t);
  await ui.send("こんにちは");
  await ui.event({ type: "error", error: { code: "internal_error", message: "Unavailable" } });
  assert.equal(ui.status(), "返答の状態を確認しています");
  await ui.advance(1_000);
  assert.equal(ui.status(), "返答を待っています");
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 1);
});

for (const outcome of ["cancelled", "completed"]) {
  test(`same composer button stops, waits for native confirmation, and handles ${outcome}`, async (t) => {
    const ui = await boot(t);
    const button = ui.button;
    await ui.send("こんにちは");
    assert.equal(button.type, "button");
    assert.equal(button.getAttribute("aria-label"), "停止");
    await ui.clickComposer();
    assert.equal(button.getAttribute("aria-label"), "停止中");
    assert.equal(button.disabled, true);
    assert.equal(ui.status(), "停止しています");
    await ui.clickComposer();
    const posts = ui.requests.filter((r) => r.method === "POST");
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1].body, { events: [{ type: "agent.session.input.cancel" }] });
    await ui.finish(outcome, "返答");
    assert.equal(ui.button, button);
    assert.equal(button.type, "submit");
    assert.equal(button.getAttribute("aria-label"), "送る");
    assert.equal(button.disabled, false);
    assert.deepEqual(ui.text(), ["こんにちは", outcome === "cancelled" ? "返答停止しました" : "返答"]);
    await ui.send("続けて");
    assert.deepEqual(ui.requests.filter((r) => r.method === "POST").at(-1).body.events[0].input[0].content, [{ type: "input_text", text: "続けて" }]);
  });
}

test("cancellation with no assistant output is visible without inventing an item or prompt", async (t) => {
  const ui = await boot(t);
  await ui.send("こんにちは");
  await ui.clickComposer();
  await ui.finish("cancelled", "");
  assert.deepEqual(ui.text(), ["こんにちは", "停止しました"]);
  assert.equal(ui.remote.items.filter((i) => i.role === "assistant").length, 0);
});

test("confirmed failure alone offers a new attempt with a new key", async (t) => {
  const ui = await boot(t);
  await ui.send("こんにちは");
  await ui.finish("failed", "");
  assert.equal(ui.elements["status-action"].textContent, "再試行");
  await ui.clickAction();
  const posts = ui.requests.filter((r) => r.method === "POST");
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].headers.get("idempotency-key"), posts[1].headers.get("idempotency-key"));
  assert.equal(ui.remote.turns.length, 2);
});

test("Enter while generating neither cancels nor sends the next draft", async (t) => {
  const ui = await boot(t);
  await ui.send("こんにちは");
  const input = ui.elements["message-input"];
  input.value = "次の下書き"; input.handlers.input();
  input.handlers.keydown({ key: "Enter", shiftKey: false, isComposing: false, preventDefault() {} });
  await ui.advance(0);
  assert.equal(input.value, "次の下書き");
  assert.equal(ui.saved.get(DRAFT_KEY), "次の下書き");
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 1);
});

test("unavailable device storage prevents sending rather than losing input", async (t) => {
  const ui = await boot(t, { storageFails: true });
  await ui.send("残す入力");
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 0);
  assert.equal(ui.elements["message-input"].value, "残す入力");
  assert.equal(ui.status(), "この端末に入力を保存できないため、送信していません。");
});

test("events arriving during history restoration cannot duplicate a completed saved item", async (t) => {
  let restored = false;
  const answer = item("完成", { status: "completed" });
  const ui = await boot(t, {
    remote: { items: [userItem(), answer], turns: [turn({ status: "completed" })] },
    fetch: async ({ path }, { emit }) => {
      if (path.includes("/items?") && !restored) {
        restored = true;
        emit({ type: "agent.session.turn.item.added", item: item("") });
        emit({ type: "agent.session.turn.output_text.delta", item_id: "msg_answer", content_index: 0, delta: "完成" });
        emit({ type: "agent.session.turn.item.done", item: answer });
        emit(turnEvent({ status: "completed" }));
      }
    },
  });
  assert.deepEqual(ui.text(), ["こんにちは", "完成"]);
  assert.equal(ui.elements["reply-status"].hidden, true);
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 0);
});

test("an open SSE response alone does not reset a history-recovery failure", async (t) => {
  const ui = await boot(t, { fetch: async ({ path }) => path.includes("/items?") ? new Response(null, { status: 503 }) : undefined });
  await ui.advance(60_000);
  assert.equal(ui.elements["status-action"].textContent, "もう一度確認");
  assert.equal(ui.timers.size, 0);
  assert.ok(ui.streams.every((stream) => stream.closed));
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 0);
});

test("stop remains available when the stream is disconnected, and reconnecting never replays cancellation", async (t) => {
  const ui = await boot(t);
  await ui.send("こんにちは");
  await ui.disconnect();
  assert.equal(ui.button.disabled, false);
  await ui.clickComposer();
  const cancellations = () => ui.requests.filter((r) => r.body?.events[0].type === "agent.session.input.cancel");
  assert.equal(cancellations().length, 1);
  await ui.disconnect();
  await ui.advance(1_000);
  assert.equal(cancellations().length, 1);
  assert.equal(ui.status(), "停止しています");
  await ui.finish("cancelled", "");
  assert.deepEqual(ui.text(), ["こんにちは", "停止しました"]);
});

test("definite input rejection restores the text to the draft without retrying", async (t) => {
  const ui = await boot(t, { fetch: async ({ method }) => method === "POST" ? new Response(null, { status: 400 }) : undefined });
  await ui.send("残す入力");
  assert.equal(ui.elements["message-input"].value, "残す入力");
  assert.equal(ui.saved.get(DRAFT_KEY), "残す入力");
  assert.equal(ui.saved.has(SUBMISSION_KEY), false);
  assert.equal(ui.status(), "送れませんでした。入力を残してあります。");
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 1);
});

test("session failure and required action are not displayed as healthy reasoning", async (t) => {
  const failed = await boot(t, { remote: { session: session({ status: "failed" }), turns: [turn()] } });
  assert.equal(failed.status(), "今は会話を続けられません。");
  assert.equal(failed.elements["status-action"].textContent, "もう一度確認");
  const waiting = await boot(t, { remote: { session: session({ status: "requires_action" }), turns: [turn({ status: "waiting" })] } });
  assert.equal(waiting.status(), "返答が一時停止しています。");
});

test("a late cancellation error does not hide a subsequently confirmed completion", async (t) => {
  const ui = await boot(t, { fetch: async ({ body }, { remote }) => {
    if (body?.events[0].type === "agent.session.input.cancel") {
      remote.turns.at(-1).status = "completed";
      remote.session.status = "idle";
      remote.items.push(item("完了しました", { status: "completed" }));
      return new Response(null, { status: 503 });
    }
  } });
  await ui.send("こんにちは");
  await ui.clickComposer();
  await ui.advance(1_000);
  assert.deepEqual(ui.text(), ["こんにちは", "完了しました"]);
  assert.equal(ui.elements["reply-status"].hidden, true);
  assert.equal(ui.button.type, "submit");
});

test("first visit is authenticated but creates an OpenAI session only on the first send", async (t) => {
  const ui = await boot(t, { remote: { session: null } });
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].headers.get("authorization"), "Bearer user-a-token");
  assert.equal(ui.button.disabled, false);
  await ui.send("はじめまして");
  const posts = ui.requests.filter((r) => r.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(posts[0].path, "/v1/agents/sessions");
  assert.deepEqual(posts[0].body, { agent: { model: "gpt-6-astra" }, environment: { type: "openai_hosted" } });
  assert.ok(ui.requests.findIndex((r) => r.path.endsWith("/events") && r.method === "GET") < ui.requests.findIndex((r) => r.body?.events));
  assert.ok(ui.requests.every((r) => r.headers.get("authorization") === "Bearer user-a-token"));
  assert.deepEqual(ui.text(), ["はじめまして"]);
});

test("unscoped legacy data and another user's drafts or pending sends never enter a new user's view", async (t) => {
  const saved = new Map([
    ["ai-simplicity.session-items", JSON.stringify({ session: session(), items: [userItem("private old conversation")], turns: [] })],
    ["ai-simplicity.draft", "private legacy draft"],
    [DRAFT_KEY, "private user A draft"],
    [SUBMISSION_KEY, JSON.stringify({ session_id: "sess_test", idempotency_key: "private_key", events: [{ type: "agent.session.input.cancel" }] })],
  ]);
  const ui = await boot(t, { saved, authSession: { user: { id: USER_B, is_anonymous: true }, access_token: "user-b-token" }, remote: { session: null } });
  assert.deepEqual(ui.text(), []);
  assert.equal(ui.elements["message-input"].value, "");
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 0);
  assert.equal(saved.get(DRAFT_KEY), "private user A draft");
});

test("account changes clear visible history and ignore an old user's delayed send acknowledgment", async (t) => {
  let acknowledge;
  const ui = await boot(t, { remote: { items: [userItem("Aだけの会話")] }, fetch: async ({ method }) => {
    if (method === "POST") return new Promise((resolve) => { acknowledge = resolve; });
  } });
  await ui.send("Aの未確認入力");
  ui.remote.session = null; ui.remote.items = []; ui.remote.turns = [];
  await ui.authenticate({ user: { id: USER_B, is_anonymous: true }, access_token: "user-b-token" });
  assert.deepEqual(ui.text(), []);
  assert.equal(ui.elements["message-input"].value, "");
  assert.ok(ui.streams.every((stream) => stream.closed));
  acknowledge(new Response(null, { status: 204 }));
  await ui.advance(0);
  assert.deepEqual(ui.text(), []);
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.saved.has(SUBMISSION_KEY), true, "A's unresolved input never becomes B's submission");
});

test("email conversion keeps the same conversation; token refresh reconnects reads without resending", async (t) => {
  const ui = await boot(t, { remote: { items: [userItem("同じ会話")], turns: [turn()] } });
  await ui.authenticate({ user: { id: USER_A, is_anonymous: false, email: "person@example.com" }, access_token: "refreshed-token" }, "TOKEN_REFRESHED");
  assert.deepEqual(ui.text(), ["同じ会話"]);
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 0);
  assert.equal(ui.requests.at(-1).headers.get("authorization"), "Bearer refreshed-token");
  assert.equal(ui.streams.length, 2);
  assert.equal(ui.streams[0].closed, true);
});

test("failed identity verification never reads API history or displays saved drafts", async (t) => {
  const ui = await boot(t, { saved: new Map([[DRAFT_KEY, "private"]]), auth: { getUser: async () => ({ error: new Error("Unavailable") }) } });
  assert.equal(ui.requests.length, 0);
  assert.deepEqual(ui.text(), []);
  assert.equal(ui.elements["message-input"].value, "");
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.elements["status-action"].textContent, "もう一度接続");
});

test("on phones Enter inserts a newline and opening the page does not summon the keyboard", async (t) => {
  const ui = await boot(t, { mobile: true });
  const input = ui.elements["message-input"];
  assert.notEqual(input.focused, true);
  input.value = "スマホの下書き";
  input.handlers.keydown({ key: "Enter", shiftKey: false, isComposing: false, preventDefault() { assert.fail("Do not intercept Enter on touch devices"); } });
  await ui.advance(0);
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 0);
  await ui.clickComposer();
  assert.deepEqual(ui.text(), ["スマホの下書き"]);
});

test("a lost creation response only triggers reads, preserving the draft and avoiding a second environment", async (t) => {
  const ui = await boot(t, { remote: { session: null }, fetch: async ({ path, method }, { remote }) => {
    if (path === "/v1/agents/sessions" && method === "POST") {
      remote.session = session();
      throw new Error("Acknowledgment lost");
    }
  } });
  await ui.send("最初の入力");
  assert.equal(ui.elements["message-input"].value, "最初の入力");
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 1);
  assert.deepEqual(ui.text(), []);
  await ui.send("最初の入力");
  assert.equal(ui.requests.filter((r) => r.method === "POST" && r.path === "/v1/agents/sessions").length, 1);
  assert.deepEqual(ui.text(), ["最初の入力"]);
});

test("a new device without working storage cannot allocate an environment or lose its first input", async (t) => {
  const ui = await boot(t, { storageFails: true, remote: { session: null } });
  await ui.send("残しておく");
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 0);
  assert.equal(ui.elements["message-input"].value, "残しておく");
});

test("an old account's delayed creation result cannot overwrite the new account's session", async (t) => {
  let complete;
  const ui = await boot(t, { remote: { session: null }, fetch: async ({ path, method }) => {
    if (path === "/v1/agents/sessions" && method === "POST") return new Promise((resolve) => { complete = resolve; });
  } });
  await ui.send("Aの最初の入力");
  await ui.authenticate({ user: { id: USER_B, is_anonymous: true }, access_token: "user-b-token" });
  const count = ui.requests.length;
  complete(Response.json(session({ id: "sess_a" })));
  await ui.advance(0);
  assert.equal(ui.requests.length, count);
  assert.deepEqual(ui.text(), []);
  assert.equal(ui.elements["message-input"].value, "");
});
