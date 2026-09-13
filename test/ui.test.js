import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const PENDING_KEY = "ai-simplicity.pending";
const DRAFT_KEY = "ai-simplicity.draft";
const pending = (fields = {}) => ({
  id: "request_1", text: "こんにちは", createdAt: new Date(100_000).toISOString(),
  partialText: "途中の返答", status: "processing", error: null, ...fields,
});

// Small DOM test double: runs the shipped script without browser automation or dependencies.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.handlers = {}; this.style = {}; this.value = ""; this.scrollHeight = 40; }
  append(node) { node.parent = this; this.children.push(node); }
  insertBefore(node, reference) { node.parent = this; this.children.splice(this.children.indexOf(reference), 0, node); }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  querySelector(tag) { return this.children.find((node) => node.tag === tag); }
  addEventListener(type, callback) { this.handlers[type] = callback; }
  focus() {}
  requestSubmit() { this.handlers.submit({ preventDefault() {} }); }
  set textContent(value) { this.text = value; }
  get textContent() { return this.text ?? this.children.map((node) => node.textContent).join(""); }
}

async function boot(handler, saved = new Map()) {
  const elements = Object.fromEntries(["messages", "composer", "message-input", "reply-status", "status-text", "status-indicator", "status-action"].map((id) => [id, new Element(id)]));
  const submit = new Element("button");
  elements.composer.append(submit);
  elements.messages.append(elements["reply-status"]);
  const timers = new Map();
  const requests = [];
  let time = 100_000, timerId = 0;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  const context = {
    document: { querySelector: (selector) => elements[selector.slice(1)], createElement: (tag) => new Element(tag), documentElement: { scrollHeight: 1000 } },
    window: { innerHeight: 1000, scrollY: 0, scrollTo() {} },
    localStorage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: (key) => saved.delete(key) },
    crypto: { randomUUID: () => "request_1" },
    Date: Clock, AbortSignal,
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, at: time + delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url, options) => {
      requests.push({ url, method: options.method ?? "GET", body: options.body ? JSON.parse(options.body) : null });
      return handler(url, options);
    },
  };
  await runInNewContext(`(async () => { ${script}\n})()`, context);
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
  return {
    elements, submit, saved, requests, timers,
    text: () => elements.messages.children.filter((node) => node.tag === "article").map((node) => node.textContent),
    async send(text) { elements["message-input"].value = text; elements.composer.requestSubmit(); await flush(); },
    async click() { elements["status-action"].handlers.click(); await flush(); },
    async advance(ms) {
      const target = time + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        time = timer.at;
        timers.delete(id);
        await timer.callback();
        await flush();
      }
      time = target;
      await flush();
    },
  };
}

test("a lost send response preserves text and recovers automatically without another send", async () => {
  let state = { messages: [], pending: null, observation: "current" };
  const ui = await boot(async (_url, options) => {
    if (options.method === "POST") {
      state = { messages: [], pending: pending(), observation: "unavailable" };
      throw new Error("Response lost");
    }
    return Response.json(state);
  });
  await ui.send("こんにちは");
  assert.deepEqual(ui.text(), ["こんにちは", "途中の返答"]);
  const originalArticles = ui.elements.messages.children.slice(0, 2);
  assert.equal(ui.elements["status-action"].hidden, true);
  state = { messages: [
    { id: "request_1", role: "user", text: "こんにちは" },
    { id: "request_1:reply", role: "assistant", text: "完成しました" },
  ], pending: null, observation: "current" };
  await ui.advance(2000);
  assert.deepEqual(ui.text(), ["こんにちは", "完成しました"]);
  assert.deepEqual(ui.elements.messages.children.slice(0, 2), originalArticles);
  assert.equal(ui.requests.filter((request) => request.method === "POST").length, 1);
  assert.equal(ui.elements["reply-status"].hidden, true);
  assert.equal(ui.saved.has(PENDING_KEY), false);
  assert.equal(ui.submit.disabled, false);
});

test("unknown results stop automatic waiting after 60 seconds and offer check, not retry", async () => {
  const ui = await boot(async () => Response.json({ messages: [], pending: pending(), observation: "unavailable" }));
  await ui.advance(4000);
  assert.equal(ui.elements["status-text"].textContent, "返答の状態を確認しています");
  await ui.advance(56_000);
  assert.equal(ui.elements["status-indicator"].hidden, true);
  assert.equal(ui.elements["status-action"].textContent, "もう一度確認");
  assert.equal(ui.timers.size, 0);
  assert.deepEqual(ui.text(), ["こんにちは", "途中の返答"]);
  await ui.click();
  assert.equal(ui.elements["status-action"].hidden, true);
  assert.equal(ui.requests.filter((request) => request.method === "POST").length, 0);
  assert.equal(ui.timers.size, 1);
});

test("healthy reasoning keeps waiting beyond 60 seconds even without any output", async () => {
  const state = { messages: [], pending: pending({ partialText: "" }), observation: "current" };
  const ui = await boot(async () => Response.json(state));
  await ui.advance(10 * 60_000);
  assert.equal(ui.elements["status-text"].textContent, "返答を待っています");
  assert.equal(ui.elements["status-action"].hidden, true);
  assert.equal(ui.elements["status-indicator"].hidden, false);
  assert.equal(ui.timers.size, 1);
  assert.ok(ui.requests.length > 250);
  state.messages = [
    { id: "request_1", role: "user", text: "こんにちは" },
    { id: "request_1:reply", role: "assistant", text: "考え終わりました" },
  ];
  state.pending = null;
  await ui.advance(2000);
  assert.deepEqual(ui.text(), ["こんにちは", "考え終わりました"]);
  assert.equal(ui.elements["reply-status"].hidden, true);
  assert.equal(ui.timers.size, 0);
});

for (const failure of ["browser connection", "upstream observation"]) {
  test(`the recovery window starts at the first ${failure} failure, not at send time`, async () => {
    let unavailable = false;
    const ui = await boot(async () => {
      if (unavailable && failure === "browser connection") throw new Error("Offline");
      return Response.json({ messages: [], pending: pending(), observation: unavailable ? "unavailable" : "current" });
    });
    await ui.advance(120_000);
    unavailable = true;
    await ui.advance(2000); // First failed observation, two minutes after send.
    assert.equal(ui.elements["status-text"].textContent, "返答の状態を確認しています");
    await ui.advance(59_999);
    assert.equal(ui.elements["status-action"].hidden, true);
    await ui.advance(1);
    assert.equal(ui.elements["status-text"].textContent, "今は返答を確認できません。入力は保存されています。");
    assert.equal(ui.elements["status-action"].textContent, "もう一度確認");
    assert.equal(ui.timers.size, 0);
    assert.equal(ui.requests.filter((request) => request.method === "POST").length, 0);
  });
}

test("a confirmed running turn clears recovery time, while HTTP success alone does not", async () => {
  let observation = "current", offline = false;
  const ui = await boot(async () => {
    if (offline) throw new Error("Offline");
    return Response.json({ messages: [], pending: pending(), observation });
  });
  await ui.advance(120_000);
  offline = true;
  await ui.advance(2000); // First failure.
  await ui.advance(20_000);
  offline = false;
  observation = "unavailable";
  await ui.advance(20_000); // HTTP works; the original recovery window keeps running.
  observation = "current";
  await ui.advance(2000);
  assert.equal(ui.elements["status-text"].textContent, "返答を待っています");
  await ui.advance(180_000);
  assert.equal(ui.elements["status-action"].hidden, true);
  observation = "unavailable";
  await ui.advance(2000); // A separate outage gets its own window.
  await ui.advance(59_999);
  assert.equal(ui.elements["status-action"].hidden, true);
  await ui.advance(1);
  assert.equal(ui.elements["status-action"].textContent, "もう一度確認");
});

test("restoring only the browser connection does not restart the recovery window", async () => {
  let offline = true;
  const ui = await boot(async () => {
    if (offline) throw new Error("Offline");
    return Response.json({ messages: [], pending: pending(), observation: "unavailable" });
  }, new Map([[PENDING_KEY, JSON.stringify(pending())]]));
  await ui.advance(40_000);
  offline = false;
  await ui.advance(19_999);
  assert.equal(ui.elements["status-action"].hidden, true);
  await ui.advance(1);
  assert.equal(ui.elements["status-action"].textContent, "もう一度確認");
  assert.equal(ui.timers.size, 0);
});

test("a lost retry response checks the outcome instead of offering another retry from stale state", async () => {
  let offline = false;
  const ui = await boot(async (url) => {
    if (url === "/api/retry") offline = true;
    if (offline) throw new Error("Response lost");
    return Response.json({ messages: [], pending: pending({ status: "failed", error: "返答を作れませんでした。入力は保存されています。" }), observation: "current" });
  });
  await ui.click();
  assert.equal(ui.elements["status-text"].textContent, "返答の状態を確認しています");
  assert.equal(ui.elements["status-action"].hidden, true);
  await ui.advance(60_000);
  assert.equal(ui.elements["status-action"].textContent, "もう一度確認");
  await ui.click();
  assert.equal(ui.requests.filter((request) => request.method === "POST").length, 1);
});

test("reload while offline preserves partial text and the next draft", async () => {
  const saved = new Map([[PENDING_KEY, JSON.stringify(pending())], [DRAFT_KEY, "次に聞くこと"]]);
  const ui = await boot(async () => { throw new Error("Offline"); }, saved);
  assert.deepEqual(ui.text(), ["こんにちは", "途中の返答"]);
  assert.equal(ui.elements["message-input"].value, "次に聞くこと");
  await ui.advance(60_000);
  assert.equal(ui.elements["status-action"].textContent, "もう一度確認");
  assert.equal(ui.elements["status-indicator"].hidden, true);
  assert.equal(ui.submit.disabled, true);
});

test("confirmed failure exposes retry, while a local failed record alone does not", async () => {
  let state = { messages: [], pending: pending({ status: "failed", error: "返答を作れませんでした。入力は保存されています。" }), observation: "current" };
  const ui = await boot(async (url) => {
    if (url === "/api/retry") state = { messages: [], pending: pending({ partialText: "", error: null }), observation: "current" };
    return Response.json(state);
  });
  assert.equal(ui.elements["status-action"].textContent, "再試行");
  assert.equal(ui.timers.size, 0);
  await ui.click();
  assert.deepEqual(ui.requests.filter((request) => request.method === "POST").map((request) => request.url), ["/api/retry"]);
  assert.equal(ui.elements["status-action"].hidden, true);
  const offline = await boot(async () => { throw new Error("Offline"); }, new Map([[PENDING_KEY, JSON.stringify(pending({ status: "failed" }))]]));
  await offline.advance(60_000);
  assert.equal(offline.elements["status-action"].textContent, "もう一度確認");
});

test("an unacknowledged local send is retained and manual resend uses the same ID", async () => {
  const ui = await boot(async (_url, options) => {
    if (options.method === "POST") throw new Error("Offline during send");
    return Response.json({ messages: [], pending: null, observation: "current" });
  });
  await ui.send("こんにちは");
  await ui.advance(60_000);
  assert.equal(ui.elements["status-action"].textContent, "もう一度送信");
  await ui.click();
  const posts = ui.requests.filter((request) => request.method === "POST");
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].body, posts[1].body);
  assert.deepEqual(ui.text(), ["こんにちは"]);
});

test("another tab's pending message never discards an unaccepted local input", async () => {
  const saved = new Map([[PENDING_KEY, JSON.stringify(pending({ text: "この端末の入力" }))]]);
  const ui = await boot(async () => Response.json({ messages: [], pending: pending({ id: "another", text: "別の端末" }), observation: "current" }), saved);
  assert.equal(ui.elements["message-input"].value, "この端末の入力");
  assert.equal(saved.get(DRAFT_KEY), "この端末の入力");
});

test("conversation-load failure has a bounded, usable recovery action", async () => {
  const ui = await boot(async () => { throw new Error("Offline"); });
  await ui.advance(60_000);
  assert.equal(ui.elements["status-text"].textContent, "今は会話を読み込めません。");
  assert.equal(ui.elements["status-action"].disabled, false);
  assert.equal(ui.timers.size, 0);
});
