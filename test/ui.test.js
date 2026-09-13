import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const PENDING_KEY = "ai-simplicity.pending";
const DRAFT_KEY = "ai-simplicity.draft";
const pending = (fields = {}) => ({
  id: "request_1", text: "こんにちは", createdAt: new Date(100_000).toISOString(),
  partialText: "途中の返答", status: "processing", error: null, stopRequested: false, ...fields,
});

// Small DOM test double: runs the shipped script without browser automation or dependencies.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.handlers = {}; this.attributes = {}; this.style = {}; this.value = ""; this.scrollHeight = 40; }
  append(node) { node.parent = this; this.children.push(node); }
  insertBefore(node, reference) { node.parent = this; this.children.splice(this.children.indexOf(reference), 0, node); }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  querySelector(tag) { return this.children.find((node) => node.tag === tag) ?? this.children.map((node) => node.querySelector(tag)).find(Boolean); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(type, callback) { this.handlers[type] = callback; }
  focus() {}
  requestSubmit() { this.handlers.submit({ preventDefault() {} }); }
  set textContent(value) { this.text = value; }
  get textContent() { return this.text ?? this.children.map((node) => node.textContent).join(""); }
}

async function boot(handler, saved = new Map()) {
  const elements = Object.fromEntries(["messages", "composer", "message-input", "reply-status", "status-text", "status-indicator", "status-action"].map((id) => [id, new Element(id)]));
  const submit = new Element("button");
  const svg = new Element("svg");
  svg.append(new Element("path"));
  submit.append(svg);
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
    Date: Clock, AbortSignal, AbortController,
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
    async click(id = "status-action") { elements[id].handlers.click(); await flush(); },
    async clickComposer() {
      if (submit.disabled) return;
      const type = submit.type;
      submit.handlers.click();
      if (type === "submit") elements.composer.requestSubmit();
      await flush();
    },
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

const stoppedMessages = (text = "途中の返答") => [
  { id: "request_1", role: "user", text: "こんにちは" },
  { id: "request_1:reply", role: "assistant", text, interruption: "user" },
];

test("stop retains the partial reply and draft, then enables the next input only after confirmation", async () => {
  let state = { messages: [], pending: pending(), observation: "current" };
  const ui = await boot(async (url) => {
    if (url === "/api/stop") state.pending.stopRequested = true;
    return Response.json(state);
  }, new Map([[DRAFT_KEY, "次の質問"]]));
  assert.equal(ui.submit.getAttribute("aria-label"), "停止");
  assert.equal(ui.submit.type, "button");
  await ui.clickComposer();
  assert.equal(ui.elements["status-text"].textContent, "停止しています");
  assert.equal(ui.submit.getAttribute("aria-label"), "停止中");
  assert.equal(ui.submit.disabled, true);
  assert.deepEqual(ui.text(), ["こんにちは", "途中の返答"]);
  assert.equal(ui.elements["message-input"].value, "次の質問");
  assert.equal(JSON.parse(ui.saved.get(PENDING_KEY)).stopRequested, true);
  state = { messages: stoppedMessages(), pending: null, observation: "current" };
  await ui.advance(2000);
  assert.deepEqual(ui.text(), ["こんにちは", "途中の返答停止しました"]);
  assert.equal(ui.elements["reply-status"].hidden, true);
  assert.equal(ui.submit.disabled, false);
  assert.equal(ui.submit.getAttribute("aria-label"), "送る");
  assert.equal(ui.submit.type, "submit");
  assert.equal(ui.elements["message-input"].value, "次の質問");
  assert.equal(ui.saved.has(PENDING_KEY), false);
  assert.equal(ui.timers.size, 0);
  assert.deepEqual(ui.requests.filter((request) => request.method === "POST"), [
    { url: "/api/stop", method: "POST", body: { id: "request_1" } },
  ]);
});

test("a lost stop response recovers the recorded intent without another stop or generation", async () => {
  let state = { messages: [], pending: pending(), observation: "current" };
  const ui = await boot(async (url) => {
    if (url === "/api/stop") {
      state = { messages: [], pending: pending({ stopRequested: true }), observation: "unavailable" };
      throw new Error("Stop response lost");
    }
    return Response.json(state);
  });
  await ui.clickComposer();
  assert.equal(ui.elements["status-text"].textContent, "停止の状態を確認しています");
  await ui.advance(60_000);
  assert.equal(ui.elements["status-text"].textContent, "今は停止を確認できません。途中の返答は保存されています。");
  assert.equal(ui.elements["status-action"].textContent, "もう一度確認");
  assert.equal(ui.submit.disabled, true);
  assert.deepEqual(ui.text(), ["こんにちは", "途中の返答"]);
  state = { messages: stoppedMessages(), pending: null, observation: "current" };
  await ui.click();
  assert.equal(ui.submit.disabled, false);
  assert.equal(ui.requests.filter((request) => request.method === "POST").length, 1);
});

test("offline reload of a stopping reply never claims it has already stopped", async () => {
  const saved = new Map([[PENDING_KEY, JSON.stringify(pending({ stopRequested: true }))], [DRAFT_KEY, "次の質問"]]);
  const ui = await boot(async () => { throw new Error("Offline"); }, saved);
  assert.equal(ui.elements["status-text"].textContent, "停止の状態を確認しています");
  assert.deepEqual(ui.text(), ["こんにちは", "途中の返答"]);
  assert.equal(ui.elements["message-input"].value, "次の質問");
  await ui.advance(60_000);
  assert.equal(ui.elements["status-action"].textContent, "もう一度確認");
  assert.equal(ui.submit.disabled, true);
});

test("stopping before any output shows only the stop label, including after reload", async () => {
  const ui = await boot(async () => Response.json({ messages: stoppedMessages(""), pending: null, observation: "current" }));
  assert.deepEqual(ui.text(), ["こんにちは", "停止しました"]);
  const reply = ui.elements.messages.children.find((node) => node.className === "message assistant");
  assert.equal(reply.querySelector("p").hidden, true);
  assert.equal(reply.querySelector("small").hidden, false);
  assert.equal(ui.submit.disabled, false);
  assert.equal(ui.submit.getAttribute("aria-label"), "送る");
});

test("a stop that was not accepted leaves a clear message and a usable stop action", async () => {
  const ui = await boot(async (url) => {
    if (url === "/api/stop") return Response.json({ error: "Unavailable" }, { status: 503 });
    return Response.json({ messages: [], pending: pending(), observation: "current" });
  });
  await ui.clickComposer();
  assert.equal(ui.elements["status-text"].textContent, "停止を確認できませんでした。もう一度お試しください。");
  assert.equal(ui.submit.getAttribute("aria-label"), "停止");
  assert.equal(ui.submit.disabled, false);
  assert.equal(ui.submit.type, "button");
});

test("stop remains usable during a slow status read and ignores its late stale result", async () => {
  let reads = 0, release;
  const oldRead = new Promise((resolve) => { release = resolve; });
  let state = { messages: [], pending: pending(), observation: "current" };
  const ui = await boot(async (url, options) => {
    if (options.method !== "POST" && ++reads === 2) return oldRead;
    if (url === "/api/stop") state = { messages: stoppedMessages(), pending: null, observation: "current" };
    return Response.json(state);
  });
  const polling = ui.advance(2000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.submit.disabled, false);
  await ui.clickComposer();
  release(Response.json({ messages: [], pending: pending(), observation: "current" }));
  await polling;
  assert.deepEqual(ui.text(), ["こんにちは", "途中の返答停止しました"]);
  assert.equal(ui.submit.disabled, false);
  assert.equal(ui.submit.getAttribute("aria-label"), "送る");
  assert.equal(ui.timers.size, 0);
});

for (const outcome of ["completed", "stopped"]) {
  test(`one composer button switches from send to stop and back after ${outcome}`, async () => {
    let state = { messages: [], pending: null, observation: "current" };
    const ui = await boot(async (url, options) => {
      if (url === "/api/messages" && options.method === "POST") state = { messages: [], pending: pending(), observation: "current" };
      if (url === "/api/stop") state.pending.stopRequested = true;
      return Response.json(state);
    });
    const button = ui.submit;
    const icon = button.querySelector("path");
    assert.equal(button.type, "submit");
    assert.equal(button.getAttribute("aria-label"), "送る");
    assert.equal(button.getAttribute("title"), "送る");
    assert.equal(icon.getAttribute("fill"), "none");
    const sendPath = icon.getAttribute("d");

    ui.elements["message-input"].value = "こんにちは";
    await ui.clickComposer();
    assert.equal(ui.submit, button);
    assert.equal(button.type, "button", "Stop must bypass the empty textarea's required validation");
    assert.equal(button.getAttribute("aria-label"), "停止");
    assert.equal(button.getAttribute("title"), "停止");
    assert.equal(icon.getAttribute("fill"), "currentColor");
    assert.equal(icon.getAttribute("d"), "M8 8h8v8H8z");
    assert.equal(ui.elements["message-input"].value, "");
    if (outcome === "stopped") {
      await ui.clickComposer();
      assert.equal(button.disabled, true);
      assert.equal(button.getAttribute("aria-label"), "停止中");
      await ui.clickComposer();
      state = { messages: stoppedMessages(), pending: null, observation: "current" };
    } else {
      state = { messages: [
        { id: "request_1", role: "user", text: "こんにちは" },
        { id: "request_1:reply", role: "assistant", text: "完成しました" },
      ], pending: null, observation: "current" };
    }
    await ui.advance(2000);
    assert.equal(button.disabled, false);
    assert.equal(button.type, "submit");
    assert.equal(button.getAttribute("aria-label"), "送る");
    assert.equal(button.getAttribute("title"), "送る");
    assert.equal(icon.getAttribute("d"), sendPath);
    assert.equal(icon.getAttribute("fill"), "none");
    assert.deepEqual(ui.requests.filter((request) => request.method === "POST").map((request) => request.url),
      outcome === "stopped" ? ["/api/messages", "/api/stop"] : ["/api/messages"]);
  });
}

test("Enter sends when idle but never stops generation or discards the next draft", async () => {
  let state = { messages: [], pending: null, observation: "current" };
  const ui = await boot(async (_url, options) => {
    if (options.method === "POST") state = { messages: [], pending: pending(), observation: "current" };
    return Response.json(state);
  });
  const input = ui.elements["message-input"];
  const enter = () => input.handlers.keydown({ key: "Enter", shiftKey: false, isComposing: false, preventDefault() {} });
  input.value = "こんにちは";
  enter();
  await ui.advance(0);
  assert.equal(ui.submit.type, "button");
  input.value = "次の質問の下書き";
  input.handlers.input();
  enter();
  await ui.advance(0);
  assert.equal(input.value, "次の質問の下書き");
  assert.equal(ui.saved.get(DRAFT_KEY), "次の質問の下書き");
  assert.deepEqual(ui.requests.filter((request) => request.method === "POST").map((request) => request.url), ["/api/messages"]);
});
