import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { createAuthenticator } from "./auth.js";
import { UserSessions, SupabaseSessionStore } from "./user-sessions.js";
import { createServer } from "./server.js";
import { Billing } from "./billing.js";
import { UserResponses, SupabaseResponseStore } from "./user-responses.js";
import { responseConfiguration } from "./response-providers.js";
import { Foundation, SupabaseFoundationKeyStore } from "./foundation.js";

for (const key of ["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"]) {
  if (!process.env[key]) {
    console.error(`${key} is required.`);
    process.exit(1);
  }
}

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error("PORT must be a valid port number.");
  process.exit(1);
}

const url = new URL(process.env.SUPABASE_URL).origin;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
if (!publishableKey.startsWith("sb_publishable_")) throw new Error("Use a Supabase publishable key, not a secret key.");
const supabaseOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: (url, options = {}) => fetch(url, {
    ...options, signal: AbortSignal.any([AbortSignal.timeout(8_000), ...(options.signal ? [options.signal] : [])]),
  }) },
};
const verifier = createClient(url, publishableKey, supabaseOptions);
const database = createClient(url, process.env.SUPABASE_SECRET_KEY, supabaseOptions);
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.OPENAI_MODEL ?? "gpt-6-astra";
// Foundation is optional: without FOUNDATION_URL and FOUNDATION_INTEGRATION_KEY, conversations carry no key to it.
const foundation = new Foundation({ url: process.env.FOUNDATION_URL, integrationKey: process.env.FOUNDATION_INTEGRATION_KEY,
  webhookSecret: process.env.FOUNDATION_WEBHOOK_SECRET, keys: new SupabaseFoundationKeyStore(database) });
// What a user's agent is given beyond the caller's own tools, whoever carries the request.
const tools = foundation.enabled ? [foundation] : [];
const sessions = new UserSessions({ client, model, store: new SupabaseSessionStore(database), tools });
const billing = new Billing(database);
const server = createServer({
  responses: new UserResponses({ ...responseConfiguration(process.env), store: new SupabaseResponseStore(database), billing, tools }),
  sessions, billing, authenticate: createAuthenticator({ auth: verifier.auth, url }), foundation,
  publicConfig: { supabase: { url, publishableKey }, session: sessions.defaults },
});

server.listen(port, host, () => {
  const address = server.address();
  const activePort = typeof address === "object" ? address.port : port;
  console.log(`ai-simplicity is listening on http://${host}:${activePort}`);
});
