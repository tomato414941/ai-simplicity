// What a person's agent is given beyond what the caller asked for, described in no provider's spelling:
//   { kind: "web_search" }
//   { kind: "mcp", label, url, token, instructions }
// A source (Foundation today) grants its rows for one user. The provider that carries the request
// translates the rows into its own format, and drops what it cannot carry, instructions included.
// A grant is kept once the request it was made for is safely in place, or dropped if that failed.
export async function grant(sources, userId) {
  const grants = [];
  for (const source of sources) grants.push(await source.grant(userId));
  return {
    tools: grants.flatMap((granted) => granted.tools),
    keep: async () => { for (const granted of grants) await granted.keep?.(); },
    drop: async () => { for (const granted of grants) await granted.drop?.().catch(() => {}); },
  };
}

// The instructions that travel with the rows a provider kept.
export function instructionsFor(tools) {
  return tools.map((tool) => tool.instructions).filter(Boolean).join("");
}
