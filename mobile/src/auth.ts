import { createClient, type Session } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";
import * as Linking from "expo-linking";
import { fetch as expoFetch } from "expo/fetch";
import { AppState } from "react-native";
import { useEffect, useState } from "react";
import type { SessionCreateParamsNonStreaming } from "openai/resources/beta/agents/sessions/sessions";
import { callbackCode, INVALID_LINK } from "./auth-flow";

export const apiOrigin = (process.env.EXPO_PUBLIC_API_URL ?? "").replace(/\/$/, "");
export const nativeFetch: typeof fetch = expoFetch;
let runtimePromise: ReturnType<typeof createRuntime> | undefined;

async function createRuntime() {
  const origin = new URL(apiOrigin);
  if (origin.protocol !== "https:" || origin.origin !== apiOrigin) throw new Error("An HTTPS API origin is required");
  const timedFetch: typeof fetch = (url, options) => nativeFetch(url, {
    ...options, signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(options?.signal ? [options.signal] : [])]),
  });
  const response = await timedFetch(`${apiOrigin}/api/config`);
  if (!response.ok) throw new Error("Configuration unavailable");
  const config = await response.json() as {
    supabase: { url: string; publishableKey: string }; session: SessionCreateParamsNonStreaming;
  };
  const { auth } = createClient(config.supabase.url, config.supabase.publishableKey, {
    auth: {
      flowType: "pkce", detectSessionInUrl: false, autoRefreshToken: true, persistSession: true,
      storage: {
        getItem: SecureStore.getItemAsync,
        setItem: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
        removeItem: SecureStore.deleteItemAsync,
      },
    },
    global: { fetch: timedFetch },
  });
  return { auth, defaults: config.session };
}
export type AuthRuntime = Awaited<ReturnType<typeof createRuntime>>;

export function useAuth() {
  const [runtime, setRuntime] = useState<AuthRuntime>();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true, booting = true;
    let cleanup = () => {};
    setError("");
    void (async () => {
      const current = await (runtimePromise ??= createRuntime().catch((error) => { runtimePromise = undefined; throw error; }));
      if (!active) return;
      setRuntime(current);
      const { auth } = current;
      const initialized = await auth.initialize();
      if (initialized.error) throw initialized.error;
      if (!active) return;
      const changed = auth.onAuthStateChange((event, next) => {
        // Do not call the SDK from inside its auth lock.
        if (active && !booting && event !== "INITIAL_SESSION") {
          setSession(next);
          setError(next ? "" : "ログインし直してください。");
        }
      });
      let lastUrl = "";
      let linking = Promise.resolve();
      const handleLink = (url: string) => {
        linking = linking.then(async () => {
          if (url === lastUrl || !active) return;
          try {
            const code = callbackCode(url);
            if (!code) return;
            lastUrl = url;
            const result = await auth.exchangeCodeForSession(code);
            if (result.error) throw result.error;
            if (active) { setSession(result.data.session); setNotice("ログインしました。"); }
          } catch { if (active) setNotice(INVALID_LINK); }
        });
        return linking;
      };
      const links = Linking.addEventListener("url", ({ url }) => { void handleLink(url); });
      const refresh = () => { if (AppState.currentState === "active") void auth.startAutoRefresh(); else void auth.stopAutoRefresh(); };
      const appState = AppState.addEventListener("change", refresh);
      cleanup = () => { changed.data.subscription.unsubscribe(); links.remove(); appState.remove(); void auth.stopAutoRefresh(); };
      refresh();
      const initialUrl = await Linking.getInitialURL();
      if (initialUrl) await handleLink(initialUrl);
      const existing = await auth.getSession();
      if (existing.error) throw existing.error;
      const result = existing.data.session ? existing : await auth.signInAnonymously();
      if (result.error) throw result.error;
      if (active) { setSession(result.data.session); booting = false; }
    })().catch(() => {
      cleanup();
      runtimePromise = undefined;
      if (active) setError("今は接続できません。少し待ってからお試しください。");
    });
    return () => { active = false; cleanup(); };
  }, [attempt]);
  return { runtime, session, error, notice, clearNotice: () => setNotice(""), retry: () => setAttempt((value) => value + 1) };
}
