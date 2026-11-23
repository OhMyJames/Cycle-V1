// Runs in the browser before each test file, with the stylesheet the app ships. Motion's animations are skipped: a test
// waits for what the person would end up seeing, not for a transition to finish.
import { MotionGlobalConfig } from "motion/react";
import { beforeEach } from "vitest";
// The app's stylesheet, as the window has it: layout, visibility and sizes are the real ones.
import "../../src/styles/built.css";

MotionGlobalConfig.skipAnimations = true;

// Every test starts from empty storage. The two files that run at once share one origin, so one file's saved state (a
// side panel opened, a section left on) would otherwise reach a test in the other.
beforeEach(() => localStorage.clear());
