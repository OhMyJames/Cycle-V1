import { expect, test } from "bun:test";
import { authorizeInBrowser, openableAuthorizationUrl } from "../src/main/connector-auth.ts";

/** A browser that goes to the sign-in page, and from there back to the callback with what the server says. */
const browser =
  (answer: Record<string, string>, seen: string[] = []) =>
  async (url: string) => {
    seen.push(url);
    const back = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
    for (const [key, value] of Object.entries(answer)) back.searchParams.set(key, value);
    const response = await fetch(back);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("close this tab");
  };

const daemon = () => {
  const finished: unknown[] = [];
  let redirect = "";
  return {
    finished,
    redirect: () => redirect,
    start: async (redirectUri: string) => {
      redirect = redirectUri;
      const url = new URL("https://auth.example/authorize");
      url.searchParams.set("redirect_uri", redirectUri);
      return { flowId: "f1", authorizationUrl: url.href };
    },
    finish: async (params: object) => {
      finished.push(params);
      return "signed in";
    },
  };
};

/** The callback is gone once a sign-in is over, whichever way it ended. */
const closed = async (redirect: string) =>
  expect(fetch(redirect, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();

test("only a web page is opened: https, or http to this machine", () => {
  expect(openableAuthorizationUrl("https://auth.example/a")).toBe(true);
  expect(openableAuthorizationUrl("http://127.0.0.1:3000/a")).toBe(true);
  expect(openableAuthorizationUrl("http://localhost/a")).toBe(true);
  expect(openableAuthorizationUrl("http://auth.example/a")).toBe(false);
  expect(openableAuthorizationUrl("file:///etc/passwd")).toBe(false);
  expect(openableAuthorizationUrl("javascript:alert(1)")).toBe(false);
  expect(openableAuthorizationUrl("not a url")).toBe(false);
});

test("the code that comes back to the loopback callback goes to the daemon with its state", async () => {
  const d = daemon();
  const outcome = await authorizeInBrowser({
    start: d.start,
    finish: d.finish,
    open: browser({ code: "the-code", state: "s1" }),
    signal: new AbortController().signal,
  });
  expect(outcome).toEqual({ kind: "done", value: "signed in" });
  expect(d.redirect()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  expect(d.finished).toEqual([{ flowId: "f1", code: "the-code", state: "s1" }]);
  await closed(d.redirect());
});

test("the person's no is a cancel; any other error from the server is a refusal; the daemon hears of both", async () => {
  for (const [error, kind] of [
    ["access_denied", "cancelled"],
    ["server_error", "refused"],
  ] as const) {
    const d = daemon();
    const outcome = await authorizeInBrowser({
      start: d.start,
      finish: d.finish,
      open: browser({ error, state: "s1" }),
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({ kind });
    expect(d.finished).toEqual([{ flowId: "f1", error }]);
    await closed(d.redirect());
  }
});

test("stopped here, or out of time, it is a cancel and the daemon is not given anything", async () => {
  const stop = new AbortController();
  const d = daemon();
  const waiting = authorizeInBrowser({
    start: d.start,
    finish: d.finish,
    open: async () => {},
    signal: stop.signal,
  });
  await Bun.sleep(20);
  stop.abort();
  expect(await waiting).toEqual({ kind: "cancelled" });

  const late = daemon();
  const timedOut = await authorizeInBrowser({
    start: late.start,
    finish: late.finish,
    open: async () => {},
    signal: new AbortController().signal,
    timeoutMs: 30,
  });
  expect(timedOut).toEqual({ kind: "cancelled" });
  expect([...d.finished, ...late.finished]).toEqual([]);
  await closed(d.redirect());
  await closed(late.redirect());
});

test("an address from the daemon that is not a web page is not opened", async () => {
  const opened: string[] = [];
  let redirect = "";
  await expect(
    authorizeInBrowser({
      start: async (uri) => {
        redirect = uri;
        return { flowId: "f1", authorizationUrl: "file:///etc/passwd" };
      },
      finish: async () => "no",
      open: async (url) => {
        opened.push(url);
      },
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("not a web page");
  expect(opened).toEqual([]);
  await closed(redirect);
});

test("stopped while the daemon is still starting the sign-in, the browser is never opened and the flow is ended", async () => {
  const d = daemon();
  const controller = new AbortController();
  const opened: string[] = [];
  const outcome = await authorizeInBrowser({
    start: async (redirectUri) => {
      const started = await d.start(redirectUri);
      controller.abort(); // the person stops waiting while discovery runs
      return started;
    },
    finish: d.finish,
    open: async (url) => {
      opened.push(url);
    },
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  expect(outcome).toEqual({ kind: "cancelled" });
  expect(opened).toEqual([]);
  expect(d.finished).toEqual([{ flowId: "f1", error: "access_denied" }]);
  await closed(d.redirect());
});
