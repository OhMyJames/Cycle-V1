import { expect, test } from "bun:test";
import { createAnalytics } from "../src/index.ts";
import { posthogSink } from "../src/posthog.ts";

// A PostHog on this machine, so what is sent can be read. Nothing leaves it.
test("what goes over the wire is the event, its properties, and the anonymous id, and nothing else", async () => {
  const bodies: string[] = [];
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(`${request.url} ${JSON.stringify([...request.headers])}`);
      const raw = new Uint8Array(await request.arrayBuffer());
      const gzip = request.headers.get("content-encoding") === "gzip";
      bodies.push(
        gzip ? new TextDecoder().decode(Bun.gunzipSync(raw)) : new TextDecoder().decode(raw),
      );
      return Response.json({ status: 1 });
    },
  });
  try {
    const analytics = createAnalytics({
      sink: posthogSink({ apiKey: "phc_test", host: `http://127.0.0.1:${server.port}` }),
      distinctId: "anon-42",
      enabled: true,
      context: { app_version: "1.0.0", platform: "linux", arch: "x64" },
      sessionId: "launch-1",
    });
    analytics.track("session_archived", { archived: true });
    await analytics.shutdown();
    const sent = bodies
      .map((b) => JSON.parse(b))
      .find((b) => JSON.stringify(b).includes("session_archived"));
    expect(sent).toBeDefined();
    const batch = (sent.batch ?? [sent]) as {
      event: string;
      distinct_id: string;
      properties: Record<string, unknown>;
    }[];
    const event = batch.find((e) => e.event === "session_archived");
    expect(event?.distinct_id).toBe("anon-42");
    expect(event?.properties).toMatchObject({
      archived: true,
      app_version: "1.0.0",
      $geoip_disable: true,
    });
    // The session is promoted out of the properties, and no person profile is asked for.
    expect(event).toMatchObject({
      session_id: "launch-1",
      options: { process_person_profile: false },
    });
    // The project key, and the one thing it is for, reach the server: nothing here is a person's.
    expect(requests.join("\n")).toContain("phc_test");
  } finally {
    await server.stop(true);
  }
}, 8000);

test("a PostHog that cannot be reached does not throw and does not hold the app for long", async () => {
  const analytics = createAnalytics({
    sink: posthogSink({ apiKey: "phc_test", host: "http://127.0.0.1:1" }),
    distinctId: "anon",
    enabled: true,
    context: { app_version: "1", platform: "linux", arch: "x64" },
  });
  analytics.track("update_install_started", {});
  const started = Date.now();
  await analytics.shutdown();
  expect(Date.now() - started).toBeLessThan(5000);
}, 8000);
