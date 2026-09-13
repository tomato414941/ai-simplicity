import OpenAI from "openai";
import { resolve } from "node:path";
import { AgentSession } from "./agent-session.js";
import { createServer } from "./server.js";
import { SessionStore } from "./session-store.js";

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required.");
  process.exit(1);
}

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error("PORT must be a valid port number.");
  process.exit(1);
}

const store = new SessionStore(resolve(process.env.STATE_PATH ?? "data/state.json"));
const session = new AgentSession({
  client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  model: process.env.OPENAI_MODEL ?? "gpt-6-astra",
  store,
});
await session.initialize();
const server = createServer({ session });

server.listen(port, () => {
  const address = server.address();
  const activePort = typeof address === "object" ? address.port : port;
  console.log(`ai-simplicity is listening on http://localhost:${activePort}`);
});
