import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { USER_A } from "./helpers.js";

const script = (await readFile(new URL("../public/account.js", import.meta.url), "utf8")).replace("export function", "function");
function account({ user = { id: USER_A, is_anonymous: true }, hasConversation = false, auth = {} } = {}) {
  const elements = Object.fromEntries(["dialog", "open", "close", "title", "description", "form", "email", "send", "toggle", "logout", "status"].map((id) => [id, {
    value: "", handlers: {}, textContent: "", addEventListener(type, handler) { this.handlers[type] = handler; },
    showModal() { this.open = true; }, close() { this.open = false; },
  }]));
  let current = user;
  const api = runInNewContext(`${script}\nmountAccount(options)`, {
    document: { querySelector: (selector) => elements[selector.slice("#account-".length)] },
    window: { location: { origin: "https://app.example" } },
    options: { auth, getUser: () => current, hasConversation: () => hasConversation, signOut: async () => { current = null; } },
  });
  return { elements, api, async submit() { await elements.form.handlers.submit({ preventDefault() {} }); },
    changeUser(value) { current = value; api.render(); } };
}

test("email registration uses Supabase updateUser, preserving the current anonymous identity", async () => {
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

test("an empty second device can sign in, without creating a new account for an unknown email", async () => {
  const calls = [];
  const ui = account({ auth: { signInWithOtp: async (args) => { calls.push(args); return {}; } } });
  ui.elements.toggle.handlers.click();
  assert.equal(ui.elements.title.textContent, "会話の続きを開く");
  ui.elements.email.value = "person@example.com";
  await ui.submit();
  assert.equal(calls[0].options.shouldCreateUser, false);
  assert.equal(calls[0].email, "person@example.com");
});

test("an auth error is useful user-facing text, never a provider diagnostic", async () => {
  const ui = account({ auth: { updateUser: async () => ({ error: { message: "secret provider diagnostic" } }) } });
  ui.elements.email.value = "person@example.com";
  await ui.submit();
  assert.equal(ui.elements.send.disabled, false);
  assert.match(ui.elements.status.textContent, /メールを送れませんでした/);
  assert.doesNotMatch(ui.elements.status.textContent, /secret|Supabase|API|実装|開発/);
});
