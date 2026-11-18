// Gives a test a browser's globals (document, window, ...), from happy-dom. It is a preload for
// the `*.dom.tsx` tests only: registering them for every test would replace streams and fetch in
// tests of the transport and the daemon.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
