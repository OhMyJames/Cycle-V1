import { expect, test } from "bun:test";
import {
  ACP_ERROR_CODES,
  agentsList,
  CYCLE_PROTOCOL_VERSION,
  CycleErrorCode,
  META,
  NOTIFICATIONS,
  ProtocolVersionSchema,
  ReplayFromSeqSchema,
  seqOf,
  sessionSetTitle,
} from "../src/index.ts";

test("Cycle's error codes do not collide with ACP's or each other", () => {
  const codes = Object.values(CycleErrorCode);
  expect(new Set(codes).size).toBe(codes.length);
  for (const code of codes) expect(ACP_ERROR_CODES).not.toContain(code);
});

test("every Cycle method and notification is under _cycle/", () => {
  expect(agentsList.name.startsWith("_cycle/")).toBe(true);
  for (const name of Object.values(NOTIFICATIONS)) expect(name.startsWith("_cycle/")).toBe(true);
});

test("the version is major.minor", () => {
  expect(ProtocolVersionSchema.safeParse(CYCLE_PROTOCOL_VERSION).success).toBe(true);
  expect(ProtocolVersionSchema.safeParse("1").success).toBe(false);
});

test("reads a seq off _meta, and only a positive integer", () => {
  expect(seqOf({ [META.seq]: 12 })).toBe(12);
  expect(seqOf({ [META.seq]: 0 })).toBeUndefined();
  expect(seqOf({ [META.seq]: "12" })).toBeUndefined();
  expect(seqOf(null)).toBeUndefined();
  expect(seqOf({})).toBeUndefined();
});

test("replayFrom seq needs a non-negative integer", () => {
  expect(ReplayFromSeqSchema.safeParse({ type: "_cycle.seq", after: 0 }).success).toBe(true);
  expect(ReplayFromSeqSchema.safeParse({ type: "_cycle.seq", after: -1 }).success).toBe(false);
});

test("a method checks what it takes", () => {
  expect(sessionSetTitle.params.safeParse({ sessionId: "s", title: "" }).success).toBe(false);
  expect(sessionSetTitle.params.safeParse({ sessionId: "s", title: "x" }).success).toBe(true);
});
