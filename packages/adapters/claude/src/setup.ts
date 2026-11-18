import type { McpServerConfig, Options } from "@anthropic-ai/claude-agent-sdk";
import { type McpServer, RequestError, type SystemPrompt } from "@cycle/acp";

/** What a session is started with beyond its directory (ACP `session/new` and `session/resume`). */
export type SessionSetup = {
  additionalDirectories: string[];
  mcpServers: Record<string, McpServerConfig>;
  systemPrompt: Options["systemPrompt"];
};

export const NO_SETUP: SessionSetup = {
  additionalDirectories: [],
  mcpServers: {},
  systemPrompt: undefined,
};

const invalid = (message: string, data: Record<string, unknown>): never => {
  throw new RequestError(-32602, message, data);
};

const absolute = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);

/** ACP's MCP servers as the SDK names them. A server is stdio or http; anything else is refused. */
export const mcpServersOf = (servers: readonly McpServer[] | null | undefined) => {
  const out: Record<string, McpServerConfig> = {};
  for (const server of servers ?? []) {
    const s = server as unknown as Record<string, unknown> & { name: string; type?: string };
    if (typeof s.name !== "string" || s.name === "") invalid("An MCP server needs a name", {});
    if (s.name in out) invalid("Two MCP servers have the same name", { name: s.name });
    if (s.type === "http") {
      if (typeof s.url !== "string" || s.url === "")
        invalid("An MCP server needs a url", { name: s.name });
      const headers = (s.headers as { name: string; value: string }[] | undefined) ?? [];
      out[s.name] = {
        type: "http",
        url: String(s.url),
        ...(headers.length > 0
          ? { headers: Object.fromEntries(headers.map((h) => [h.name, h.value])) }
          : {}),
      };
    } else if (s.type === "stdio" || s.type === undefined) {
      if (typeof s.command !== "string" || s.command === "") {
        invalid("An MCP server needs a command", { name: s.name });
      }
      const env = (s.env as { name: string; value: string }[] | undefined) ?? [];
      out[s.name] = {
        type: "stdio",
        command: String(s.command),
        args: (s.args as string[] | undefined) ?? [],
        ...(env.length > 0 ? { env: Object.fromEntries(env.map((e) => [e.name, e.value])) } : {}),
      };
    } else {
      invalid("This MCP transport is not supported", { name: s.name, type: s.type });
    }
  }
  return out;
};

/**
 * ACP's system prompt as the SDK takes it. Only `append` is supported: it adds to Claude Code's own
 * instructions. `override` would replace them, tool instructions included, and is refused.
 */
export const systemPromptOf = (
  prompt: SystemPrompt | null | undefined,
): Options["systemPrompt"] => {
  if (prompt === null || prompt === undefined) return undefined;
  if (prompt.mode !== "append") {
    return invalid("Only an appended system prompt is supported", { mode: prompt.mode });
  }
  const text = prompt.content.map((block) => {
    if (block.type !== "text") invalid("A system prompt is text", { type: block.type });
    return (block as { text: string }).text;
  });
  if (text.length === 0) invalid("A system prompt cannot be empty", {});
  return { type: "preset", preset: "claude_code", append: text.join("\n\n") };
};

export const setupOf = (params: {
  additionalDirectories?: readonly string[] | null;
  mcpServers?: readonly McpServer[] | null;
  systemPrompt?: SystemPrompt | null;
}): SessionSetup => {
  const directories = [...(params.additionalDirectories ?? [])];
  for (const directory of directories) {
    if (!absolute(directory)) invalid("A directory must be an absolute path", { directory });
  }
  return {
    additionalDirectories: directories,
    mcpServers: mcpServersOf(params.mcpServers),
    systemPrompt: systemPromptOf(params.systemPrompt),
  };
};
