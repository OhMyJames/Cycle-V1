/**
 * What this build is: the release version, put in by `scripts/build.ts` (the same one the app has, so
 * a daemon and an app of one release agree). A run from source is `dev`.
 */
export const VERSION: string = process.env.CYCLE_BUILD_VERSION ?? "dev";
