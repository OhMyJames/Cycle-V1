// Gives a test a browser's globals (document, window, ...), from happy-dom. It is a preload for
// the `*.dom.tsx` tests only: registering them for every test would replace streams and fetch in
// tests of the transport and the daemon.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MotionGlobalConfig } from "motion/react";

GlobalRegistrator.register({ url: "http://localhost/" });
// happy-dom's Web Animations API rejects `animation.finished` with an unhandled AbortError when
// motion cancels an in-flight animation on unmount or rapid state transitions in DOM tests.
MotionGlobalConfig.skipAnimations = true;
