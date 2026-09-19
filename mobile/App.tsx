import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator, Alert, AppState, FlatList, KeyboardAvoidingView, Modal, Platform,
  Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as Crypto from "expo-crypto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Session } from "@supabase/supabase-js";
import { SessionClient, type Message } from "./src/session-client";
import { useAuth, apiOrigin, nativeFetch, type AuthRuntime } from "./src/auth";
import { AUTH_REDIRECT, emailError } from "./src/auth-flow";

const colors = { paper: "#10110f", ink: "#e9e6de", muted: "#a2a69b", line: "#373b33", user: "#e7e1d5" };
const sans = Platform.select({ ios: "Avenir Next", default: "sans-serif" });
const serif = Platform.select({ ios: "Iowan Old Style", default: "serif" });

export default function App() {
  const auth = useAuth();
  return <SafeAreaProvider>
    <StatusBar style="light" />
    {auth.runtime && auth.session && !auth.error
      ? <Conversation key={auth.session.user.id} runtime={auth.runtime} session={auth.session} notice={auth.notice} clearNotice={auth.clearNotice} />
      : <SafeAreaView style={styles.loading}>
          {!auth.error && <ActivityIndicator color={colors.muted} />}
          <Text style={styles.status}>{auth.error || "準備しています"}</Text>
          {auth.error && <TextButton title="もう一度接続" onPress={auth.retry} />}
        </SafeAreaView>}
  </SafeAreaProvider>;
}

function Conversation({ runtime, session, notice, clearNotice }: {
  runtime: AuthRuntime; session: Session; notice: string; clearNotice(): void;
}) {
  const client = useMemo(() => new SessionClient({
    origin: apiOrigin, userId: session.user.id, token: session.access_token,
    defaults: runtime.defaults, fetch: nativeFetch, storage: AsyncStorage, uuid: Crypto.randomUUID,
  }), [runtime, session.user.id]);
  const view = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [accountOpen, setAccountOpen] = useState(false);
  const list = useRef<FlatList<Message>>(null);
  const nearBottom = useRef(true);

  useEffect(() => {
    if (AppState.currentState !== "active") client.pause();
    void client.start();
    const listener = AppState.addEventListener("change", (state) => state === "active" ? client.resume() : client.pause());
    return () => { listener.remove(); client.dispose(); };
  }, [client]);
  useEffect(() => { client.setToken(session.access_token); }, [client, session.access_token]);
  useEffect(() => { if (notice) setAccountOpen(true); }, [notice]);
  const disabled = view.generating ? !view.canStop : !view.canSend;

  return <SafeAreaView style={styles.screen}>
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.column}>
        <View style={styles.header}>
          <Text style={styles.wordmark}>AI</Text>
          <TextButton title="アカウント" onPress={() => setAccountOpen(true)} />
        </View>
        <FlatList ref={list} data={view.messages} keyExtractor={(item) => item.id} style={styles.flex}
          contentContainerStyle={styles.messages} keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled"
          onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
            nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 160;
          }} scrollEventThrottle={100}
          onContentSizeChange={() => { if (nearBottom.current) list.current?.scrollToEnd({ animated: false }); }}
          renderItem={({ item }) => <MessageRow message={item} />}
          ItemSeparatorComponent={Separator}
        />
        <View style={styles.bottom}>
          {!!view.status && <View style={styles.statusRow} accessibilityLiveRegion="polite">
            <Text style={styles.status}>{view.status}</Text>
            {!!view.action && <TextButton title={view.action} onPress={() => { void client.retry(); }} />}
          </View>}
          <View style={styles.composer}>
            <TextInput style={styles.input} value={view.draft} onChangeText={(value) => client.setDraft(value)}
              multiline editable={view.canEdit} maxLength={20_000} placeholder="話しかける" placeholderTextColor={colors.muted}
              accessibilityLabel="メッセージ" selectionColor={colors.user} textAlignVertical="top"
              submitBehavior="newline" />
            <Pressable accessibilityRole="button" accessibilityLabel={view.generating ? view.stopping ? "停止中" : "停止" : "送る"}
              disabled={disabled} accessibilityState={{ disabled }}
              onPress={() => { nearBottom.current = true; void (view.generating ? client.stop() : client.send()); }}
              style={({ pressed }) => [styles.send, disabled && styles.disabled, pressed && styles.pressed]}>
              {view.generating ? <View style={styles.stopIcon} /> : <View style={styles.arrow}>
                <View style={styles.arrowStem} /><View style={styles.arrowHead} />
              </View>}
            </Pressable>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
    <Account visible={accountOpen} onClose={() => { setAccountOpen(false); clearNotice(); }}
      runtime={runtime} session={session} hasConversation={view.hasConversation} notice={notice} />
  </SafeAreaView>;
}

function Separator() { return <View style={{ height: 26 }} />; }
function MessageRow({ message }: { message: Message }) {
  const user = message.role === "user";
  return <View style={user ? styles.userMessage : styles.assistantMessage}>
    {!!message.text && <Text selectable style={user ? styles.userText : styles.assistantText}>{message.text}</Text>}
    {!!message.ending && <Text style={styles.ending}>{message.ending}</Text>}
  </View>;
}

function Account({ visible, onClose, runtime, session, hasConversation, notice }: {
  visible: boolean; onClose(): void; runtime: AuthRuntime; session: Session; hasConversation: boolean; notice: string;
}) {
  const [mode, setMode] = useState<"register" | "login">("register");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const registered = !session.user.is_anonymous;
  useEffect(() => { if (visible) { setStatus(""); setMode("register"); } }, [visible]);
  const title = registered ? "アカウント" : mode === "login" ? "会話の続きを開く" : "この会話を引き継ぐ";

  async function sendEmail() {
    if (busy || !email.trim()) return;
    if (mode === "login" && hasConversation) { setStatus("この会話を残すには、先にメールアドレスを登録してください。"); return; }
    setBusy(true); setStatus("");
    try {
      const result = mode === "register"
        ? await runtime.auth.updateUser({ email: email.trim() }, { emailRedirectTo: AUTH_REDIRECT })
        : await runtime.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false, emailRedirectTo: AUTH_REDIRECT } });
      if (result.error) throw result.error;
      setStatus("メールを送りました。この端末で、最新のメールのリンクを開いてください。");
    } catch (error) { setStatus(emailError(error)); }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true);
    try {
      const result = await runtime.auth.signOut({ scope: "local" });
      if (result.error) throw result.error;
      // The auth view offers reconnect; no new anonymous identity until requested.
      onClose();
    } catch { setStatus("ログアウトできませんでした。もう一度お試しください。"); }
    finally { setBusy(false); }
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.account} keyboardShouldPersistTaps="handled">
          <View style={styles.closeRow}><TextButton title="閉じる" onPress={onClose} /></View>
          <Text accessibilityRole="header" style={styles.title}>{title}</Text>
          <Text style={styles.description}>{registered
            ? `${session.user.email}\n別の端末でも、このメールアドレスで会話を続けられます。`
            : mode === "login" ? "登録済みのメールアドレスに、ログイン用のリンクを送ります。"
            : "メールアドレスを登録すると、別の端末でもこの会話を続けられます。登録するまでは、アプリや端末のデータを消さないでください。"}</Text>
          {!registered && <View style={styles.accountForm}>
            <Text style={styles.label}>メールアドレス</Text>
            <TextInput value={email} onChangeText={setEmail} style={styles.email} accessibilityLabel="メールアドレス"
              placeholder="you@example.com" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false}
              keyboardType="email-address" autoComplete="email" textContentType="emailAddress" editable={!busy}
              onSubmitEditing={() => { void sendEmail(); }} returnKeyType="send" />
            <Pressable accessibilityRole="button" disabled={busy || !email.trim()} onPress={() => { void sendEmail(); }}
              style={({ pressed }) => [styles.primary, (busy || !email.trim()) && styles.disabled, pressed && styles.pressed]}>
              <Text style={styles.primaryText}>{busy ? "メールを送っています" : "メールを送る"}</Text>
            </Pressable>
            {!hasConversation && <TextButton disabled={busy} title={mode === "login" ? "この会話を引き継ぐ" : "登録済みのメールでログイン"}
              onPress={() => { setMode(mode === "login" ? "register" : "login"); setStatus(""); }} />}
          </View>}
          {!!(status || notice) && <Text style={styles.accountStatus} accessibilityLiveRegion="polite">{status || notice}</Text>}
          {registered && <TextButton disabled={busy} title="ログアウト" onPress={() => Alert.alert("ログアウトしますか？", "会話は、同じメールアドレスでログインすると開けます。", [
            { text: "戻る", style: "cancel" }, { text: "ログアウト", onPress: () => { void logout(); } },
          ])} />}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

function TextButton({ title, onPress, disabled = false }: { title: string; onPress(): void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.textButton, disabled && styles.disabled, pressed && styles.pressed]}>
    <Text style={styles.textButtonLabel}>{title}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.paper },
  loading: { flex: 1, backgroundColor: colors.paper, justifyContent: "center", alignItems: "center", padding: 32, gap: 16 },
  column: { flex: 1, width: "100%", maxWidth: 760, alignSelf: "center" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 4 },
  wordmark: { color: colors.muted, fontFamily: serif, fontSize: 22, letterSpacing: 1 },
  messages: { paddingHorizontal: 22, paddingTop: 22, paddingBottom: 30, flexGrow: 1 },
  userMessage: { alignSelf: "flex-end", maxWidth: "88%", borderRadius: 21, borderBottomRightRadius: 5, paddingVertical: 13, paddingHorizontal: 18, backgroundColor: colors.user },
  assistantMessage: { alignSelf: "flex-start", maxWidth: "96%", borderLeftWidth: 2, borderLeftColor: "#747b73", paddingLeft: 18, paddingVertical: 4 },
  userText: { color: "#181916", fontFamily: sans, fontSize: 16, lineHeight: 26 },
  assistantText: { color: colors.ink, fontFamily: serif, fontSize: 18, lineHeight: 30 },
  ending: { color: colors.muted, fontFamily: sans, fontSize: 13, lineHeight: 22, marginTop: 6 },
  bottom: { paddingHorizontal: 16, paddingBottom: 10 },
  statusRow: { paddingHorizontal: 8, paddingVertical: 8 },
  status: { color: colors.muted, fontFamily: sans, fontSize: 13, lineHeight: 21 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 28, backgroundColor: "#1c1e1b", padding: 7, paddingLeft: 18 },
  input: { flex: 1, color: colors.ink, fontFamily: sans, fontSize: 17, lineHeight: 25, minHeight: 44, maxHeight: 168, paddingTop: 10, paddingBottom: 10 },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.user, justifyContent: "center", alignItems: "center" },
  stopIcon: { width: 14, height: 14, borderRadius: 2, backgroundColor: colors.paper },
  arrow: { width: 22, height: 22, alignItems: "center", justifyContent: "center" },
  arrowStem: { width: 2, height: 19, backgroundColor: colors.paper, borderRadius: 1 },
  arrowHead: { position: "absolute", width: 11, height: 11, borderTopWidth: 2, borderLeftWidth: 2, borderColor: colors.paper, transform: [{ rotate: "45deg" }], top: 3 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  textButton: { minHeight: 44, justifyContent: "center", paddingVertical: 10, paddingHorizontal: 10, alignSelf: "flex-start" },
  textButtonLabel: { color: colors.muted, fontFamily: sans, fontSize: 14, lineHeight: 22 },
  account: { paddingHorizontal: 28, paddingBottom: 40, width: "100%", maxWidth: 560, alignSelf: "center" },
  closeRow: { flexDirection: "row", justifyContent: "flex-end", paddingTop: 8, marginRight: -10 },
  title: { color: colors.ink, fontFamily: sans, fontSize: 25, lineHeight: 36, marginTop: 20, marginBottom: 20 },
  description: { color: colors.muted, fontFamily: sans, fontSize: 15, lineHeight: 27 },
  accountForm: { marginTop: 28, gap: 12 },
  label: { color: colors.ink, fontFamily: sans, fontSize: 13 },
  email: { borderWidth: 1, borderColor: "#555b50", borderRadius: 12, padding: 14, fontSize: 17, color: colors.ink, fontFamily: sans },
  primary: { backgroundColor: colors.user, borderRadius: 14, minHeight: 52, alignItems: "center", justifyContent: "center", padding: 12 },
  primaryText: { color: colors.paper, fontFamily: sans, fontSize: 16 },
  accountStatus: { color: colors.ink, fontFamily: sans, fontSize: 14, lineHeight: 25, marginTop: 20, marginBottom: 12 },
});
