import type { AgentSession, AgentSessionEvent, AgentSessionItem } from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";

export function isTerminal(turn?: Pick<Turn, "status"> | null): boolean;
export function itemText(item: { content?: ReadonlyArray<{ type: string; text?: string }> }): string;
export class SessionState {
  session: AgentSession | null;
  items: Map<string, AgentSessionItem>;
  turns: Map<string, Turn>;
  readonly latestTurn: Turn | undefined;
  restore(session: AgentSession, items: AgentSessionItem[], turns: Turn[]): void;
  apply(event: AgentSessionEvent): void;
}
export function readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentSessionEvent>;
