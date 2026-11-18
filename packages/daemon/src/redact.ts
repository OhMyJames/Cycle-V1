/**
 * What may be kept in a session's history (docs/protocol.md §12, "日志不包含任何凭证").
 *
 * Applied once, where a record goes into the log (`Daemon.#write`). Clients get a record as the log
 * writes it, so the disk, the live push and a replay all show the same, already filtered, data.
 *
 * Two rules, both on purpose narrow: a wrong guess changes what a person sees in their own history.
 *  1. A value whose KEY names a secret (password, token, api key, authorization, cookie, ...) is
 *     replaced, wherever it is nested, in tool calls and in permission requests.
 *  2. In what a tool was given or returned (text, commands, file contents), strings that are
 *     certainly credentials are replaced: well-known token shapes, private key blocks, and
 *     `NAME_KEY=value` assignments (what `cat .env` prints).
 * What the person and the model said (`user_message_chunk`, `agent_message_chunk`, ...) is not touched:
 * it arrives in pieces a pattern cannot see across, and it is the person's own words.
 */

export const REDACTED = "[redacted]";

const MAX_DEPTH = 32;

/** Keys compared after lower-casing and dropping `_`, `-`, `.` and spaces. `tokens` (a count) is not a secret. */
const SECRET_KEY =
  /(password|passwd|passphrase|secret|apikey|accesskey|privatekey|credential|authorization|cookie)s?$|token$/;
/** Keys that name a secret even though they end in something else. */
const SECRET_KEY_EXACT = new Set(["auth", "bearer", "pwd", "pin"]);

const normalize = (key: string): string => key.toLowerCase().replace(/[_\-. ]/g, "");

export const isSecretKey = (key: string): boolean => {
  const name = normalize(key);
  return SECRET_KEY_EXACT.has(name) || SECRET_KEY.test(name);
};

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
/** Shapes that are credentials and nothing else. */
const TOKEN_SHAPES = [
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g;
/** `ANTHROPIC_API_KEY=sk...` (what `cat .env` prints): the name stays, the value goes. Upper case only: `const token = f()` is code. */
const ENV_ASSIGNMENT =
  /(\b[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?)[ \t]*=[ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s"';]+)/g;
/** `--token=abc`, `--api-key abc`. */
const FLAG =
  /(--[a-z0-9-]*(?:token|password|passwd|secret|api-key|apikey)(?:=|[ \t]+))("[^"\n]*"|'[^'\n]*'|[^\s"'-][^\s"']*)/gi;
/** `"password": "abc"` in JSON that is text (a config file, a curl body). */
const JSON_PAIR = /("([^"\n]{1,64})"[ \t]*:[ \t]*)("(?:[^"\\\n]|\\.)*")/g;

const keep = (value: string): boolean => value === REDACTED || value === `"${REDACTED}"`;

/** A string with the credentials in it replaced. Cheap when there is nothing to replace. */
export const redactText = (text: string): string => {
  if (text.length < 8) return text;
  let out = text.replace(PRIVATE_KEY_BLOCK, REDACTED);
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED);
  out = out.replace(BEARER, (_, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(ENV_ASSIGNMENT, (whole, name: string, value: string) =>
    keep(value) ? whole : `${name}${REDACTED}`,
  );
  out = out.replace(FLAG, (whole, name: string, value: string) =>
    keep(value) ? whole : `${name}${REDACTED}`,
  );
  out = out.replace(JSON_PAIR, (whole, head: string, key: string, value: string) =>
    isSecretKey(key) && value !== '""' && !keep(value) ? `${head}"${REDACTED}"` : whole,
  );
  return out;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A copy of `value` for a tool's input or output. Keys that name a secret lose their value; strings
 * are cleaned of credentials. `{name: "API_KEY", value: "..."}` pairs (how an env list is written)
 * lose the `value`.
 */
export const redactTool = (value: unknown, depth = 0): unknown => {
  if (typeof value === "string") return redactText(value);
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactTool(item, depth + 1));
  if (!isObject(value)) return value;
  const named = typeof value.name === "string" && isSecretKey(value.name);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const secret = isSecretKey(key) || (named && key === "value");
    out[key] = secret && item != null && item !== "" ? REDACTED : redactTool(item, depth + 1);
  }
  return out;
};

const TOOL_UPDATES = new Set(["tool_call", "tool_call_update"]);

/** The data of a record as it may be kept. A record that has nothing to clean comes back as it is. */
export const redactRecord = (kind: string, data: unknown): unknown => {
  if (!isObject(data)) return data;
  if (kind === "update" && typeof data.sessionUpdate === "string") {
    return TOOL_UPDATES.has(data.sessionUpdate) ? redactTool(data) : data;
  }
  if (kind === "request" && isObject(data.params))
    return { ...data, params: redactParams(data.params) };
  return data;
};

/**
 * The params of a request to the clients. A permission request carries the tool call; an
 * elicitation's schema may have a field called "password": the form needs it, and what was typed
 * is kept out of the log elsewhere (`withoutContent`).
 */
export const redactParams = (params: Record<string, unknown>): Record<string, unknown> => {
  const out = { ...params };
  // ACP v2 puts the tool call in `subject`; the older shape had it at the top.
  if (isObject(out.toolCall)) out.toolCall = redactTool(out.toolCall);
  if (isObject(out.subject) && isObject(out.subject.toolCall))
    out.subject = { ...out.subject, toolCall: redactTool(out.subject.toolCall) };
  return out;
};
