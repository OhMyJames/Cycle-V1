// Runs in the browser before each test file, with the stylesheet the app ships. Motion's animations are skipped: a test
// waits for what the person would end up seeing, not for a transition to finish.
import { MotionGlobalConfig } from "motion/react";
// The app's stylesheet, as the window has it: layout, visibility and sizes are the real ones.
import "../../src/styles/built.css";

MotionGlobalConfig.skipAnimations = true;
