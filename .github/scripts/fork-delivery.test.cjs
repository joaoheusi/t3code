const assert = require("node:assert/strict");
const test = require("node:test");
const {
  planForkRelease,
  hasRecentIosRuntime,
  ensureForkReleaseDraft,
  planIosDelivery,
} = require("./fork-delivery.cjs");

function fixture({ order = "ahead", ci = "success", main = "ahead", releases = [] } = {}) {
  const sha = "a".repeat(40);
  return {
    repo: { owner: "joaoheusi", repo: "t3code" },
    sha,
    sequence: 101,
    github: {
      rest: {
        repos: {
          compareCommitsWithBasehead: async ({ basehead }) => ({
            data: { status: basehead === `${sha}...main` ? main : order },
          }),
          listReleases() {},
        },
        actions: {
          listWorkflowRuns: async (params) => ({
            data: {
              workflow_runs:
                params.workflow_id === "ci.yml" &&
                params.head_sha === sha &&
                params.event === "push"
                  ? [{ status: "completed", conclusion: ci }]
                  : [],
            },
          }),
        },
      },
      paginate: async () => releases,
    },
  };
}

test("retries mobile after desktop publication, skips old commits, and rejects divergent releases", async () => {
  const releases = [{ tag_name: "v0.2.100", draft: false, prerelease: false }];
  assert.deepEqual(await planForkRelease(fixture({ releases })), {
    skip: false,
    published: false,
    version: "0.2.101",
    tag: "v0.2.101",
  });
  assert.equal((await planForkRelease(fixture({ releases, order: "identical" }))).published, true);
  assert.equal((await planForkRelease(fixture({ releases, order: "behind" }))).skip, true);
  await assert.rejects(planForkRelease(fixture({ releases, order: "diverged" })), /diverged/);
  await assert.rejects(planForkRelease({ ...fixture({ releases }), sequence: 99 }), /increase/);
});

test("requires passing CI and a commit on the fork's main", async () => {
  await assert.rejects(planForkRelease(fixture({ ci: "failure" })), /CI must pass/);
  await assert.rejects(planForkRelease(fixture({ main: "diverged" })), /not contained/);
  await assert.rejects(
    planForkRelease({ ...fixture(), repo: { owner: "pingdotgg", repo: "t3code" } }),
    /only publish/,
  );
});

test("ignores draft releases and evidence uploads when choosing the next release", async () => {
  const result = await planForkRelease(
    fixture({
      releases: [
        { tag_name: "v0.2.200", draft: true },
        { tag_name: "pr-9-ui-evidence", draft: false },
        { tag_name: "v0.2.300", prerelease: true },
      ],
    }),
  );
  assert.equal(result.tag, "v0.2.101");
  assert.equal(result.published, false);
});

test("only reuses a matching, unexpired runtime whose upload was recorded", () => {
  const fingerprint = "b".repeat(40);
  const now = new Date("2026-10-31T12:00:00Z");
  assert.equal(
    hasRecentIosRuntime(fingerprint, [`j4-ios-runtime-${fingerprint}-2026-10-01-42`], now),
    true,
  );
  assert.equal(
    hasRecentIosRuntime(fingerprint, [`j4-ios-runtime-${fingerprint}-2026-08-18-42`], now),
    true,
  );
  assert.equal(
    hasRecentIosRuntime(
      fingerprint,
      [`j4-ios-runtime-${fingerprint}-2026-08-17-42`],
      new Date("2026-10-31T00:00:00Z"),
    ),
    false,
  );
  for (const tags of [
    [],
    [`j4-ios-runtime-${fingerprint}-2026-08-17-42`],
    [`j4-ios-runtime-${fingerprint}-2026-07-01-42`],
    [`j4-ios-runtime-${"c".repeat(40)}-2026-10-01-42`],
    [`j4-ios-runtime-${fingerprint}-2026-11-01-42`],
  ]) {
    assert.equal(hasRecentIosRuntime(fingerprint, tags, now), false);
  }
});

test("draft reuse requires the exact commit and refuses mismatched tags or published releases", async () => {
  const sha = "a".repeat(40);
  const repo = { owner: "joaoheusi", repo: "t3code" };
  const tag = "v0.2.101";
  let release;
  let tagSha;
  const github = {
    rest: {
      repos: {
        getReleaseByTag: async () => {
          if (!release) throw { status: 404 };
          return { data: release };
        },
        getCommit: async ({ ref }) => {
          if (ref === tag) {
            if (!tagSha) throw { status: 404 };
            return { data: { sha: tagSha } };
          }
          return { data: { sha: ref === "main" ? sha : ref } };
        },
        createRelease: async (input) => {
          release = input;
          return { data: input };
        },
      },
    },
  };
  const run = () => ensureForkReleaseDraft({ github, repo, sha, tag });
  await run();
  assert.equal(release.target_commitish, sha);
  assert.equal(release.draft, true);
  await run();
  release.target_commitish = "main";
  await assert.rejects(run(), /commit/);
  release.target_commitish = "b".repeat(40);
  await assert.rejects(run(), /commit/);
  release.target_commitish = sha;
  tagSha = "b".repeat(40);
  await assert.rejects(run(), /commit/);
  tagSha = sha;
  await run();
  release.draft = false;
  await assert.rejects(run(), /draft/);
  release = undefined;
  tagSha = "b".repeat(40);
  await assert.rejects(run(), /commit/);
  assert.equal(release, undefined);
  github.rest.repos.getReleaseByTag = async () => {
    throw { status: 403 };
  };
  await assert.rejects(run(), (error) => error.status === 403);
});

test("refreshing a native build also publishes updates to compatible existing installs", () => {
  const fingerprint = "b".repeat(40);
  const input = {
    fingerprint,
    tags: [`j4-ios-runtime-${fingerprint}-2026-10-01-42`],
    now: new Date("2026-10-31T12:00:00Z"),
  };
  assert.deepEqual(planIosDelivery({ ...input, forceBuild: false }), {
    build: false,
    publishUpdate: true,
  });
  assert.deepEqual(planIosDelivery({ ...input, forceBuild: true }), {
    build: true,
    publishUpdate: true,
  });
  assert.deepEqual(planIosDelivery({ ...input, tags: [], forceBuild: false }), {
    build: true,
    publishUpdate: false,
  });
});
