// A daemon served as `cycle serve` serves one, which then meets an error nothing catches: what a person finds in its log
// afterwards is the test (logger.test.ts). The data directory is the test's own, never a real one.
import { pathsFor } from "../../src/config.ts";
import { onSignalsAndCrashes, serve } from "../../src/serve.ts";

const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error("usage: crash-serve.ts <data dir>");
const running = await serve(pathsFor(dataDir));
onSignalsAndCrashes(running);
setTimeout(() => {
  throw new Error("the index went away under the daemon");
}, 20);
