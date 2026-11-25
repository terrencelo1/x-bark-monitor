// Trigger Worker for x-bark-monitor (scheme 2).
// wrangler.toml needs: [[triggers]] crons = ["* * * * *"]
// Secrets: GH_PAT — fine-grained PAT, Actions: write, ONLY the
// x-bark-monitor repo. (The existing muse-gex-deploy PAT is scoped to
// gex-deploy and cannot dispatch this repo.)
export default {
  async scheduled(event, env, ctx) {
    const res = await fetch(
      "https://api.github.com/repos/terrencelo1/x-bark-monitor/actions/workflows/poll.yml/dispatches",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GH_PAT}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ ref: "main" }),
      }
    );
    // 204 = dispatched. Anything else (401/403/404/422) means the PAT,
    // repo name, or workflow file is wrong — log it, do not retry blindly.
    console.log("dispatch:", res.status);
  },
};
