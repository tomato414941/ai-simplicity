import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { USER_A, USER_B } from "./helpers.js";

const script = (await readFile(new URL("../public/account.js", import.meta.url), "utf8")).replace("export function", "function");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const balance = (values = {}) => ({ unit: "credit", balance: "0", reserved: "0", available: "0", pricing_status: "unconfigured", ...values });
const entry = (values = {}) => ({ id: "entry_1", kind: "grant", credits: "100", created_at: "2026-09-23T12:30:00Z", ...values });
const history = (data = [], next = null) => ({ data, has_more: Boolean(next), next });

class Element {
  constructor(tag) { this.tag = tag; this.value = ""; this.handlers = {}; this.attributes = {}; this.children = []; }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  showModal() { this.open = true; }
  close() { this.open = false; this.handlers.close?.(); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.text = ""; this.children = nodes; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text ?? "") + this.children.map((node) => node.textContent).join(""); }
  setAttribute(name, value) { this.attributes[name] = value; }
}

function account({ user = { id: USER_A, is_anonymous: true }, hasConversation = false, auth = {}, request } = {}) {
  const elements = Object.fromEntries([...html.matchAll(/<([\w-]+)\b[^>]*\bid="account-([\w-]+)"([^>]*)>([^<]*)/g)].map(([, tag, id, attributes, text]) => {
    const element = new Element(tag);
    element.hidden = /\bhidden\b/.test(attributes);
    element.textContent = text.trim();
    return [id, element];
  }));
  let current = user;
  const requests = [];
  const api = runInNewContext(`${script}\nmountAccount(options)`, {
    AbortController, URLSearchParams,
    document: { querySelector: (selector) => elements[selector.slice("#account-".length)], createElement: (tag) => new Element(tag) },
    window: { location: { origin: "https://app.example" } },
    options: { auth, getUser: () => current, hasConversation: () => hasConversation, signOut: async () => { current = null; },
      request: async (path, signal) => {
        requests.push({ path, signal, userId: current?.id });
        return request ? request(path, signal) : path === "/api/billing" ? balance() : history();
      },
    },
  });
  return { elements, api, requests,
    async click(name) { elements[name].handlers.click(); await flush(); },
    async submit() { await elements.form.handlers.submit({ preventDefault() {} }); },
    changeUser(value) { current = value; api.render(); } };
}

test("メール登録で匿名ユーザーの会話を引き継ぐ", async () => {
  const calls = [];
  const ui = account({ hasConversation: true, auth: { updateUser: async (...args) => { calls.push(args); return {}; } } });
  ui.elements.open.handlers.click();
  assert.equal(ui.elements.dialog.open, true);
  assert.equal(ui.elements.title.textContent, "この会話を引き継ぐ");
  assert.match(ui.elements.description.textContent, /ブラウザのデータを消さない/);
  assert.equal(ui.elements.toggle.hidden, true);
  assert.equal(ui.elements.logout.hidden, true);
  ui.elements.email.value = " person@example.com ";
  await ui.submit();
  assert.equal(JSON.stringify(calls), JSON.stringify([[{ email: "person@example.com" }, { emailRedirectTo: "https://app.example/" }]]));
  assert.match(ui.elements.status.textContent, /メールのリンクを開いて/);
  assert.equal(ui.elements.form.hidden, false, "Sending an email does not yet prove it was verified");
  ui.changeUser({ id: USER_A, is_anonymous: false, email: "person@example.com" });
  assert.equal(ui.elements.form.hidden, true);
  assert.equal(ui.elements.logout.hidden, false);
  assert.match(ui.elements.description.textContent, /person@example.com/);
});

test("会話のない端末から登録済みメールでログインする", async () => {
  const calls = [];
  const ui = account({ auth: { signInWithOtp: async (args) => { calls.push(args); return {}; } } });
  ui.elements.toggle.handlers.click();
  assert.equal(ui.elements.title.textContent, "会話の続きを開く");
  ui.elements.email.value = "person@example.com";
  await ui.submit();
  assert.equal(calls[0].options.shouldCreateUser, false);
  assert.equal(calls[0].email, "person@example.com");
});

test("メール送信の失敗を利用者向けの文言で案内する", async () => {
  const ui = account({ auth: { updateUser: async () => ({ error: { message: "secret provider diagnostic" } }) } });
  ui.elements.email.value = "person@example.com";
  await ui.submit();
  assert.equal(ui.elements.send.disabled, false);
  assert.match(ui.elements.status.textContent, /メールを送れませんでした/);
  assert.doesNotMatch(ui.elements.status.textContent, /secret|Supabase|API|実装|開発/);
});

test("匿名ユーザーにも本人の残高と変更履歴を表示する", async () => {
  const ui = account({ request: async (path) => path === "/api/billing"
    ? balance({ balance: "1100", reserved: "100", available: "1000" })
    : history([
      entry({ kind: "refund", credits: "20", reason: "internal reason", pricing: { version: "internal price" } }),
      entry({ id: "entry_2", kind: "charge", credits: "-20" }),
      entry({ id: "entry_3", credits: "1100" }),
    ]) });
  assert.equal(ui.requests.length, 0);
  await ui.click("open");
  assert.deepEqual(ui.requests.map(({ path, userId }) => ({ path, userId })), [
    { path: "/api/billing", userId: USER_A }, { path: "/api/billing/entries?limit=20", userId: USER_A },
  ]);
  assert.equal(ui.elements.usage.hidden, false);
  assert.equal(ui.elements["usage-body"].hidden, false);
  assert.equal(ui.elements["usage-available"].textContent, "1,000");
  assert.equal(ui.elements["usage-balance"].textContent, "1,100");
  assert.equal(ui.elements["usage-reserved"].textContent, "100");
  assert.equal(ui.elements["usage-hold-note"].hidden, false);
  assert.equal(ui.elements["usage-empty"].hidden, true);
  const rows = ui.elements["usage-entries"].children;
  assert.deepEqual(rows.map((row) => row.children[0].children[0].textContent), ["クレジット返還", "利用", "クレジット追加"]);
  assert.deepEqual(rows.map((row) => row.children[1].textContent), ["+20", "-20", "+1,100"]);
  assert.equal(rows[0].children[1].attributes["aria-label"], "+20クレジット");
  assert.equal(rows[0].children[0].children[1].dateTime, "2026-09-23T12:30:00Z");
  assert.match(rows[0].textContent, /2026年9月23日/);
});

test("クレジット消費がない現在の利用条件と空の履歴を案内する", async () => {
  const ui = account();
  await ui.click("open");
  assert.equal(ui.elements["usage-available"].textContent, "0");
  assert.equal(ui.elements["usage-notice"].hidden, false);
  assert.equal(ui.elements["usage-notice"].textContent, "現在はクレジットを消費せずに利用できます。");
  assert.equal(ui.elements["usage-empty"].hidden, false);
  assert.equal(ui.elements["usage-empty"].textContent, "残高の変更はまだありません。");
  assert.equal(ui.elements["usage-hold-note"].hidden, true);
  assert.equal(ui.elements["usage-more"].hidden, true);
});

test("大きなクレジット残高と明細を丸めずに表示する", async () => {
  const amount = "9223372036854775807";
  const ui = account({ request: async (path) => path === "/api/billing"
    ? balance({ balance: amount, available: amount }) : history([entry({ credits: amount })]) });
  await ui.click("open");
  assert.equal(ui.elements["usage-available"].textContent, "9,223,372,036,854,775,807");
  assert.equal(ui.elements["usage-balance"].textContent, "9,223,372,036,854,775,807");
  assert.equal(ui.elements["usage-entries"].children[0].children[1].textContent, "+9,223,372,036,854,775,807");
});

test("読み込み中と失敗時には残高を未表示にして更新で再取得する", async () => {
  let reject;
  let failed = true;
  const ui = account({ request: async (path) => {
    if (path !== "/api/billing") return history();
    if (failed) return new Promise((_, fail) => { reject = fail; });
    return balance({ balance: "100", available: "100" });
  } });
  await ui.click("open");
  assert.equal(ui.elements["usage-body"].hidden, true);
  assert.equal(ui.elements["usage-status"].textContent, "読み込んでいます…");
  assert.equal(ui.elements["usage-refresh"].disabled, true);
  reject(new Error("private provider diagnostic"));
  await flush();
  assert.equal(ui.elements["usage-body"].hidden, true);
  assert.equal(ui.elements["usage-available"].textContent, "—");
  assert.equal(ui.elements["usage-status"].textContent, "利用状況を読み込めませんでした。もう一度お試しください。");
  assert.equal(ui.elements["usage-refresh"].disabled, false);
  failed = false;
  await ui.click("usage-refresh");
  assert.equal(ui.elements["usage-body"].hidden, false);
  assert.equal(ui.elements["usage-status"].textContent, "");
  assert.equal(ui.elements["usage-available"].textContent, "100");
});

test("履歴の続きを再試行して同じ明細を重複させずに表示する", async () => {
  let attempts = 0;
  const ui = account({ request: async (path) => {
    if (path === "/api/billing") return balance();
    if (!path.includes("after=")) return history([entry()], "entry_1");
    if (++attempts === 1) throw new Error("Offline");
    return history([entry({ id: "entry_2", kind: "charge", credits: "-10" })]);
  } });
  await ui.click("open");
  assert.equal(ui.elements["usage-more"].hidden, false);
  await ui.click("usage-more");
  assert.equal(ui.elements["usage-entries"].children.length, 1);
  assert.equal(ui.elements["usage-page-status"].textContent, "続きを読み込めませんでした。もう一度お試しください。");
  assert.equal(ui.elements["usage-more"].disabled, false);
  await ui.click("usage-more");
  assert.deepEqual(ui.requests.slice(2).map(({ path }) => path), Array(2).fill("/api/billing/entries?limit=20&after=entry_1"));
  assert.deepEqual(ui.elements["usage-entries"].children.map((row) => row.children[1].textContent), ["+100", "-10"]);
  assert.equal(ui.elements["usage-more"].hidden, true);
  assert.equal(ui.elements["usage-page-status"].textContent, "");
});

test("画面を閉じると読み込みを中止し再度開いた時点の残高を表示する", async () => {
  let resolve;
  const ui = account({ request: async (path) => path === "/api/billing"
    ? new Promise((done) => { resolve = done; }) : history([entry()]) });
  await ui.click("open");
  await ui.click("close");
  assert.equal(ui.requests[0].signal.aborted, true);
  resolve(balance({ balance: "100", available: "100" }));
  await flush();
  assert.equal(ui.elements["usage-body"].hidden, true);
  assert.equal(ui.elements["usage-entries"].children.length, 0);
  await ui.click("open");
  resolve(balance({ balance: "200", available: "200" }));
  await flush();
  assert.equal(ui.elements["usage-available"].textContent, "200");
});

test("アカウントを切り替えると表示を消し切り替え先の残高だけを表示する", async () => {
  let previousPage;
  let nextBalance;
  let nextUser = false;
  const ui = account({ request: async (path) => {
    if (path.includes("after=")) return new Promise((done) => { previousPage = done; });
    if (nextUser) return path === "/api/billing" ? new Promise((done) => { nextBalance = done; }) : history();
    return path === "/api/billing" ? balance({ balance: "100", available: "100" }) : history([entry()], "entry_1");
  } });
  await ui.click("open");
  await ui.click("usage-more");
  nextUser = true;
  ui.changeUser({ id: USER_B, is_anonymous: false, email: "next@example.com" });
  assert.equal(ui.elements["usage-body"].hidden, true);
  assert.equal(ui.elements["usage-available"].textContent, "—");
  assert.equal(ui.elements["usage-entries"].children.length, 0);
  assert.equal(ui.requests[2].signal.aborted, true);
  nextBalance(balance({ balance: "250", available: "250" }));
  await flush();
  previousPage(history([entry({ id: "private_previous_entry" })]));
  await flush();
  assert.equal(ui.elements["usage-available"].textContent, "250");
  assert.equal(ui.elements["usage-empty"].hidden, false);
  assert.equal(ui.elements["usage-entries"].children.length, 0);
  assert.equal(ui.elements.title.textContent, "登録情報");
});

test("ログアウトすると残高を隠してログインを案内する", async () => {
  const ui = account({ user: { id: USER_A, is_anonymous: false, email: "person@example.com" } });
  await ui.click("open");
  await ui.click("logout");
  await ui.click("open");
  assert.equal(ui.elements.usage.hidden, true);
  assert.equal(ui.elements["usage-available"].textContent, "—");
  assert.equal(ui.elements.title.textContent, "会話の続きを開く");
  assert.equal(ui.elements.form.hidden, false);
});
