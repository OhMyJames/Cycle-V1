// The only place that imports the ACP SDK. `scripts/check.ts` rejects every other import of it.
// The SDK is pinned to an exact version in this package's package.json: ACP v2 is a draft and may
// change incompatibly in any release, so upgrades are made on purpose, with the diff in hand.
//
// Only the stable-feature set of v2 is exposed. The unstable entry point (`session/fork`,
// `session/archive`, `session/set_title`, ...) is deliberately not used: see docs/decisions/0005.

export * from "@agentclientprotocol/sdk/experimental/v2";
