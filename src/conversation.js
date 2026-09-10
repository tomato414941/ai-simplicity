const INSTRUCTIONS = `You are the intelligence behind one simple, continuous conversation.
Be warm, direct, and genuinely useful. Respond in the language the person uses unless they ask otherwise.
The person never needs to organize chats, choose a model, or understand internal AI machinery.
Use relevant context naturally. Do not force unrelated earlier topics into the current reply.
When an action has consequences or requires missing information, make that clear and preserve the person's control.`;

export class Conversation {
  #client;
  #model;
  #store;
  #turnQueue = Promise.resolve();

  constructor({ client, model, store }) {
    this.#client = client;
    this.#model = model;
    this.#store = store;
  }

  async messages() {
    const state = await this.#store.read();
    return state.messages;
  }

  async send(text, { onDelta = () => {} } = {}) {
    const turn = this.#turnQueue.then(() => this.#send(text, onDelta));
    this.#turnQueue = turn.catch(() => {});
    return turn;
  }

  async #send(text, onDelta) {
    let state = await this.#store.read();
    let conversationId = state.conversationId;

    if (!conversationId) {
      const conversation = await this.#client.conversations.create();
      conversationId = conversation.id;
      state = await this.#store.update((current) => ({
        ...current,
        conversationId,
      }));
    }

    const stream = await this.#client.responses.create({
      model: this.#model,
      conversation: conversationId,
      instructions: INSTRUCTIONS,
      input: text,
      stream: true,
    });

    let reply = "";

    for await (const event of stream) {
      if (
        event.type === "response.output_text.delta" ||
        event.type === "response.refusal.delta"
      ) {
        reply += event.delta;
        onDelta(event.delta);
      }

      if (event.type === "response.output_text.done") {
        reply = event.text;
      }

      if (event.type === "response.refusal.done") {
        reply = event.refusal;
      }

      if (event.type === "response.failed") {
        throw new Error(event.response?.error?.message ?? "The model response failed.");
      }

      if (event.type === "response.incomplete") {
        throw new Error("The model response was incomplete.");
      }
    }

    reply = reply.trim();
    if (!reply) {
      throw new Error("The model returned no text.");
    }

    const createdAt = new Date().toISOString();
    await this.#store.update((current) => ({
      ...current,
      messages: [
        ...current.messages,
        { role: "user", text, createdAt },
        { role: "assistant", text: reply, createdAt },
      ],
    }));

    return { role: "assistant", text: reply, createdAt };
  }
}
