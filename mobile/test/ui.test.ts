import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";
import { AUTH_REDIRECT, INVALID_LINK, emailError } from "../src/auth-flow.ts";

const source = await readFile(new URL("../App.tsx", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "tsx", jsx: "automatic", format: "cjs" });
type Node = { type: string | Function; props: any; children?: Node[] };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// Render the shipped JSX with native primitives/hooks replaced. This checks
// visible copy and controls, not iOS/Android layout or keyboard behavior.
function screen(options: { generating?: boolean; history?: boolean; registered?: boolean; notice?: string } = {}) {
  const states = new Map<string, any[]>();
  let scope = "", cursor = 0;
  const calls: any[] = [];
  const view = {
    messages: [{ id: "m1", role: "assistant", text: "こんにちは。", ending: "" }],
    draft: "質問", status: "", action: "", generating: Boolean(options.generating), stopping: false,
    canSend: true, canStop: true, canEdit: true, hasConversation: Boolean(options.history),
  };
  const runtime = { auth: {
    async updateUser(...args: any[]) { calls.push(["updateUser", ...args]); return { error: null }; },
    async signInWithOtp(...args: any[]) { calls.push(["signInWithOtp", ...args]); return { error: null }; },
  } };
  const react = {
    useEffect() {}, useMemo: (fn: Function) => fn(), useRef: (value: any) => ({ current: value }),
    useSyncExternalStore: (_subscribe: Function, get: Function) => get(),
    useState(initial: any) {
      const values = states.get(scope) ?? []; states.set(scope, values);
      const index = cursor++;
      if (!(index in values)) values[index] = initial;
      return [values[index], (value: any) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
    },
  };
  const native: any = { Platform: { OS: "ios", select: (values: any) => values.ios }, StyleSheet: { create: (s: any) => s }, Alert: { alert() {} } };
  for (const type of ["ActivityIndicator", "FlatList", "KeyboardAvoidingView", "Modal", "Pressable", "ScrollView", "Text", "TextInput", "View"]) native[type] = type;
  const modules: Record<string, any> = {
    react, "react/jsx-runtime": { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) },
    "react-native": native,
    "react-native-safe-area-context": { SafeAreaProvider: "SafeAreaProvider", SafeAreaView: "SafeAreaView" },
    "expo-status-bar": { StatusBar: "StatusBar" }, "expo-crypto": {}, "@react-native-async-storage/async-storage": {},
    "./src/session-client": { SessionClient: class {
      getSnapshot = () => view; subscribe() {};
      send() { calls.push(["send"]); } stop() { calls.push(["stop"]); }
      setDraft(text: string) { view.draft = text; }
    } },
    "./src/auth": { useAuth: () => ({ runtime, session: { user: { id: "test-user", is_anonymous: !options.registered, email: options.registered ? "person@example.com" : undefined }, access_token: "test-token" }, notice: options.notice ?? "", clearNotice() {} }) },
    "./src/auth-flow": { AUTH_REDIRECT, INVALID_LINK, emailError },
  };
  const exports: any = {};
  const context = { module: { exports }, exports, require(name: string) { assert.ok(name in modules, name); return modules[name]; } };
  runInNewContext(code, context);
  function expand(node: any, path = "root"): any {
    if (node === null || node === undefined || typeof node === "boolean") return null;
    if (typeof node === "string" || typeof node === "number") return { type: "literal", props: { value: String(node) }, children: [] };
    if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}.${i}`)).filter(Boolean).flat();
    if (typeof node.type === "function") {
      scope = `${path}:${node.type.name}`; cursor = 0;
      return expand(node.type(node.props), path);
    }
    if (node.type === "Modal" && !node.props.visible) return null;
    const children = node.type === "FlatList" ? node.props.data.map((item: any) => node.props.renderItem({ item })) : node.props.children;
    return { ...node, children: [expand(children, `${path}.children`)].flat().filter(Boolean) };
  }
  let tree: Node;
  const render = () => { tree = expand({ type: context.module.exports.default, props: {} }); };
  const all = (node = tree): Node[] => [node, ...(node.children ?? []).flatMap((child) => all(child))];
  const text = (node = tree) => all(node).filter((n) => n.type === "literal").map((n) => n.props.value).join(" ");
  const button = (label: string) => all().find((node) => node.type === "Pressable" && (node.props.accessibilityLabel === label || text(node) === label))!;
  render();
  return { calls, view, render, all, text, button,
    async click(label: string) { const node = button(label); assert.ok(node, label); assert.ok(!node.props.disabled, label); node.props.onPress(); await flush(); render(); },
    async email(address: string) { all().find((n) => n.type === "TextInput" && n.props.accessibilityLabel === "メールアドレス")!.props.onChangeText(address); render(); await flush(); },
  };
}

test("the shipped native composer uses one send/stop control and preserves mobile newlines", async () => {
  const ui = screen();
  const input = ui.all().find((node) => node.type === "TextInput")!;
  assert.equal(input.props.multiline, true);
  assert.equal(input.props.submitBehavior, "newline");
  assert.notEqual(input.props.autoFocus, true);
  await ui.click("送る");
  ui.view.generating = true; ui.render();
  assert.equal(ui.button("送る"), undefined);
  await ui.click("停止");
  assert.deepEqual(ui.calls, [["send"], ["stop"]]);
  ui.view.stopping = true; ui.view.canStop = false; ui.render();
  assert.equal(ui.button("停止中").props.disabled, true);
});

test("native email registration links the current user and does not expose implementation copy", async () => {
  const ui = screen({ history: true });
  await ui.click("アカウント");
  assert.match(ui.text(), /この会話を引き継ぐ/);
  assert.equal(ui.button("登録済みのメールでログイン"), undefined);
  await ui.email("person@example.com"); await ui.click("メールを送る");
  assert.equal(ui.calls[0][0], "updateUser");
  assert.equal(ui.calls[0][1].email, "person@example.com");
  assert.equal(ui.calls[0][2].emailRedirectTo, AUTH_REDIRECT);
  assert.match(ui.text(), /この端末で、最新のメールのリンクを開いてください/);
  assert.doesNotMatch(ui.text(), /Supabase|Expo|OpenAI|実装|開発|session_id|ストリーミング/);
});

test("an empty phone can log into the existing web account without making a new user", async () => {
  const ui = screen();
  await ui.click("アカウント"); await ui.click("登録済みのメールでログイン");
  assert.match(ui.text(), /会話の続きを開く/);
  await ui.email("person@example.com"); await ui.click("メールを送る");
  assert.equal(ui.calls[0][0], "signInWithOtp");
  assert.equal(ui.calls[0][1].options.shouldCreateUser, false);
  assert.equal(ui.calls[0][1].options.emailRedirectTo, AUTH_REDIRECT);
});

test("registered accounts show their email and invalid links have a visible explanation", async () => {
  const ui = screen({ registered: true, notice: INVALID_LINK });
  await ui.click("アカウント");
  assert.match(ui.text(), /person@example.com/);
  assert.match(ui.text(), /このリンクは使えません/);
  assert.ok(ui.button("ログアウト"));
  assert.equal(ui.button("メールを送る"), undefined);
});
