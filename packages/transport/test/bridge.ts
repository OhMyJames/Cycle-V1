// What `cycle-daemon proxy` does, as a script for the ssh test.
import { bridgeStdio } from "../src/server.ts";

const path = process.argv[2];
if (path === undefined) throw new Error("no socket path");
await bridgeStdio(path, {
  stdin: Bun.stdin.stream(),
  stdout: new WritableStream({
    write: (chunk) => {
      process.stdout.write(chunk);
    },
  }),
});
process.exit(0);
