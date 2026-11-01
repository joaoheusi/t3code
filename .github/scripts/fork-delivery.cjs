const FORK_REPOSITORY = "joaoheusi/t3code";
const RELEASE_TAG = /^v0\.2\.(\d+)$/;

async function planForkRelease({ github, repo, sha, sequence }) {
  if (`${repo.owner}/${repo.repo}` !== FORK_REPOSITORY) {
    throw new Error("Fork delivery may only publish joaoheusi/t3code.");
  }
  if (!/^[a-f0-9]{40}$/.test(sha) || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("Invalid fork release commit or sequence.");
  }
  const comparison = await github.rest.repos.compareCommitsWithBasehead({
    ...repo,
    basehead: `${sha}...main`,
  });
  if (!["ahead", "identical"].includes(comparison.data.status)) {
    throw new Error("The release commit is not contained in main.");
  }
  const ci = await github.rest.actions.listWorkflowRuns({
    ...repo,
    workflow_id: "ci.yml",
    head_sha: sha,
    event: "push",
    per_page: 1,
  });
  const run = ci.data.workflow_runs[0];
  if (!run || run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("CI must pass on this exact commit before delivery.");
  }
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...repo,
    per_page: 100,
  });
  const published = releases.filter(
    (r) => !r.draft && !r.prerelease && RELEASE_TAG.test(r.tag_name),
  );
  const latest = published.sort(
    (a, b) => Number(b.tag_name.match(RELEASE_TAG)[1]) - Number(a.tag_name.match(RELEASE_TAG)[1]),
  )[0];
  const version = `0.2.${sequence}`;
  const tag = `v${version}`;
  if (latest) {
    const order = await github.rest.repos.compareCommitsWithBasehead({
      ...repo,
      basehead: `${latest.tag_name}...${sha}`,
    });
    if (order.data.status === "behind") return { skip: true, published: false, version, tag };
    if (order.data.status === "diverged") throw new Error("Release history diverged from main.");
    if (order.data.status === "identical")
      return { skip: false, published: true, version, tag: latest.tag_name };
    if (sequence <= Number(latest.tag_name.match(RELEASE_TAG)[1])) {
      throw new Error("The release version must increase.");
    }
  }
  return { skip: false, published: false, version, tag };
}

function hasRecentIosRuntime(fingerprint, tags, now) {
  if (!/^[a-f0-9]{40}$/.test(fingerprint)) throw new Error("Invalid iOS runtime fingerprint.");
  return tags.some((tag) => {
    const match = tag.match(
      new RegExp(`^j4-ios-runtime-${fingerprint}-(\\d{4}-\\d{2}-\\d{2})-\\d+$`),
    );
    if (!match) return false;
    const age = now.getTime() - new Date(`${match[1]}T00:00:00Z`).getTime();
    return age >= 0 && age < 75 * 24 * 60 * 60 * 1000;
  });
}

module.exports = { planForkRelease, hasRecentIosRuntime };
