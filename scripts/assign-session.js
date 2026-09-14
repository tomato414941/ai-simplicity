import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SessionStore } from "../src/session-store.js";
import { SupabaseSessionStore } from "../src/user-sessions.js";

// Explicit, one-time assignment only. The server never claims a legacy session
// for the first visitor, and this script never edits the source state file.
export async function assignSession({ userId, sessionId, admin, store, client }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId) || !sessionId) {
    throw new Error("A specific user ID and session ID are required.");
  }
  const { data, error } = await admin.getUserById(userId);
  if (error || data?.user?.id !== userId || data.user.is_anonymous || !data.user.email_confirmed_at) {
    throw new Error("Choose a user whose email address has been verified.");
  }
  if (await store.read(userId)) throw new Error("This user already has a conversation. Nothing was changed.");
  const session = await client.beta.agents.sessions.retrieve(sessionId, { maxRetries: 0, timeout: 8_000 });
  if (session.id !== sessionId) throw new Error("Could not verify the existing session.");
  await store.write(userId, sessionId);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error("Usage: node scripts/assign-session.js /absolute/path/to/state.json USER_ID");
  for (const key of ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "OPENAI_API_KEY"]) {
    if (!process.env[key]) throw new Error(`${key} is required.`);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  await assignSession({
    userId: process.argv[3], sessionId: await new SessionStore(resolve(process.argv[2])).read(),
    admin: supabase.auth.admin, store: new SupabaseSessionStore(supabase),
    client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  });
  console.log("Existing session assigned. The source state file was left unchanged.");
}
