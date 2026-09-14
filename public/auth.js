import { createClient } from "@supabase/supabase-js";

export async function openAuth() {
  const response = await fetch("/api/config", { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Could not load configuration.");
  const config = await response.json();
  const { auth } = createClient(config.supabase.url, config.supabase.publishableKey);
  return { auth, sessionDefaults: config.session };
}
