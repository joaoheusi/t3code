const assert = require("node:assert/strict");
const test = require("node:test");
const { planForkRelease, hasRecentIosRuntime } = require("./fork-delivery.cjs");

function fixture({ order = "ahead", ci = "success", main = "ahead", releases = [] } = {}) {
  return {
    repo: { owner: "joaoheusi", repo: "t3code" },
    sha: "a".repeat(40),
    sequence: 101,
    github: {
      rest: {
        repos: {
          compareCommitsWithBasehead: async ({ basehead }) => ({
            data: { status: basehead.endsWith("...main") ? main : order },
          }),
          listReleases() {},
        },
        actions: {
          listWorkflowRuns: async () => ({
            data: { workflow_runs: [{ status: "completed", conclusion: ci }] },
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
  for (const tags of [
    [],
    [`j4-ios-runtime-${fingerprint}-2026-07-01-42`],
    [`j4-ios-runtime-${"c".repeat(40)}-2026-10-01-42`],
    [`j4-ios-runtime-${fingerprint}-2026-11-01-42`],
  ]) {
    assert.equal(hasRecentIosRuntime(fingerprint, tags, now), false);
  }
});
