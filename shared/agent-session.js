export const isTerminal = (turn) => ["completed", "failed", "cancelled"].includes(turn?.status);
const isFinalItem = (item) => ["completed", "incomplete"].includes(item?.status);
export const itemText = (item) => (item?.content ?? [])
  .filter((part) => ["input_text", "output_text"].includes(part.type)).map((part) => part.text).join("");

// Shared view of native resources for the web and mobile clients.
export class SessionState {
  session = null;
  items = new Map();
  turns = new Map();
  #gaps = new Set();
  #seen = new Set();

  get latestTurn() { return [...this.turns.values()].filter((turn) => turn.subagent_id == null).at(-1); }

  restore(session, items, turns) {
    const sameSession = this.session?.id === session.id;
    const previousTurns = sameSession ? this.turns : new Map();
    const previous = sameSession ? this.items : new Map();
    this.session = session;
    this.items = new Map();
    this.turns = new Map(turns.map((turn) => [turn.id, turn]));
    for (const [id, turn] of previousTurns) {
      if (!this.turns.has(id) || (isTerminal(turn) && !isTerminal(this.turns.get(id)))) this.turns.set(id, turn);
    }
    this.#gaps.clear();
    this.#seen.clear();
    for (const [index, item] of items.entries()) {
      const key = item.id ?? `${item.turn_id}:${item.role}:${index}`;
      this.items.set(key, previous.has(key) && !isFinalItem(item) ? previous.get(key) : item);
      if (!isFinalItem(item)) this.#gaps.add(key);
    }
    // Saved items cannot reconstruct every missed intermediate event. Keep any
    // previously visible fragment, but never guess how a new delta joins it.
    for (const [id, item] of previous) {
      if (!this.items.has(id)) {
        this.items.set(id, item);
        if (!isFinalItem(item)) this.#gaps.add(id);
      }
    }
  }

  apply(event) {
    if (event.event_id && this.#seen.has(event.event_id)) return;
    if (event.event_id) this.#seen.add(event.event_id);
    if (event.session) this.session = event.session;
    if (event.turn) {
      const previous = this.turns.get(event.turn.id);
      if (!isTerminal(previous)) this.turns.set(event.turn.id, event.turn);
    }
    if (["agent.session.idle", "agent.session.in_progress", "agent.session.requires_action", "agent.session.failed"].includes(event.type) && this.session) {
      this.session = { ...this.session, status: event.type.slice("agent.session.".length) };
    }
    if (event.type === "agent.session.turn.item.added" || event.type === "agent.session.turn.item.done") {
      if (isFinalItem(this.items.get(event.item.id))) return;
      if (event.type.endsWith(".added") && this.#gaps.has(event.item.id)) return;
      this.items.set(event.item.id, structuredClone(event.item));
      if (event.type.endsWith(".done")) this.#gaps.delete(event.item.id);
      return;
    }
    const item = this.items.get(event.item_id);
    if (!item || isFinalItem(item) || !Array.isArray(item.content)) return;
    const index = event.content_index;
    if (!Number.isInteger(index) || index < 0) return;
    if (event.type === "agent.session.turn.content_part.done") {
      item.content[index] = structuredClone(event.part);
    } else if (event.type === "agent.session.turn.content_part.added") {
      item.content[index] ??= structuredClone(event.part);
    } else if (event.type === "agent.session.turn.output_text.done") {
      item.content[index] = { ...item.content[index], type: "output_text", text: event.text };
    } else if (event.type === "agent.session.turn.output_text.delta" && !this.#gaps.has(event.item_id)) {
      const part = item.content[index] ??= { type: "output_text", text: "" };
      part.text += event.delta;
    }
  }
}

// SSE framing, not a new event protocol. Event names and JSON are left intact.
export async function* readEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", data = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 4 * 1024 * 1024) throw new Error("Event stream frame is too large.");
      let match;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        if (!done && match[0] === "\r" && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (line === "") {
          if (!data.length) continue;
          const json = data.join("\n");
          data = [];
          if (json === "[DONE]") return;
          yield JSON.parse(json);
        } else if (line === "data") data.push("");
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (done) return; // An EOF does not imply a completed turn.
    }
  } finally {
    // A tee branch's cancellation waits for its sibling. Request cancellation
    // without blocking parser completion on that independent consumer.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
