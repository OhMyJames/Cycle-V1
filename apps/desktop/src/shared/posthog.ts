// The PostHog project an installed app reports to. The key is public: it can only add events, so it is kept in the
// source. Only `package` puts it into a build (build.json); a run from source and the tests have none, so they send nothing.
export const POSTHOG_KEY = "phc_ty7vZhUo2LSbxaZdWUAnMAi5tTg7c3XxpwQLmrJD6YJ2";
/** The US region. */
export const POSTHOG_HOST = "https://us.i.posthog.com";
