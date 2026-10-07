# J4 Code (Unofficial)

J4 Code is a personal fork of T3 Code. This build adds quick actions, repository bindings in one thread, and PR tasks that stay in the current thread. It is a development build. Check the [release verification record](../fork/acceptance-status.json) before using it for daily work.

## Keep the official installation separate

The macOS app is **J4 Code (Unofficial)**. Its app ID is `dev.joaoheusi.j4code`. Its default data directory is `~/.j4code`; its Electron profile is `~/Library/Application Support/j4code`. The official application and its data remain separate.

The fork reads `J4CODE_HOME` for a custom data directory. It ignores the official `T3CODE_HOME` setting. Do not point the fork at the official profile. Initial updates are manual. The desktop updater, CLI updater, and server updater cannot replace this fork with an official release.

Keep the official application available while testing this build. To return to it, close J4 Code and open the official application. Do not copy the fork's migrated database back into the official profile.

## Quick actions

Open **Quick actions** beside the composer. Search by name, alias, or tag. Select an action to insert its text. You still choose when to send it.

Use **Settings → Quick actions** to create, edit, duplicate, disable, favorite, import, or export actions. Actions belong to one execution environment. Shared-environment readers can read permitted templates; these are not a secret vault. Project-scoped actions belong to a project on that same environment.

Configure the palette shortcut or an action's direct shortcut in the existing keybinding system. No default binding replaces an upstream shortcut. Existing terminal and preview focus conditions still apply.

Normal templates use the captured cursor or selection. CI and conflict tasks append text. Attachments and context chips remain. If the draft changes while context loads, use **Append to current draft** or cancel. If you navigate away, the prepared task stays with its original target for five minutes. Return there and insert it explicitly.

Template variables include `{{date}}`, `{{time}}`, `{{clipboard}}`, `{{thread.title}}`, `{{workspace.repositories}}`, `{{repo.name}}`, `{{repo.path}}`, `{{repo.branch}}`, `{{pr.url}}`, and `{{ci.failures}}`. Escape a literal placeholder with a backslash: `\{{date}}`. Unknown or missing variables block insertion. Clipboard access happens only when the selected template asks for it. Repository and PR context comes from the execution host.

Portable V1 import maps copy, paste, and inherit delivery modes to insertion after a preview. Portable exports use copy delivery. Fork-only variables must be removed by an explicit edit before portable export. Imported actions cannot register code, shell commands, context builders, or shortcuts.

## Several repositories in one thread

Open **Repositories** beside the composer before starting the thread's first provider session. Add absolute folders on the execution host, or discover repositories beneath a folder. Review the candidates before adding them. Discovery is bounded and does not follow symlinks or initialize submodules.

Choose a checkout mode for each repository:

- **Current checkout** keeps its actual branch and files.
- **Existing worktree** reuses the selected checkout after validation.
- **New worktree** creates a new branch from the selected base commit. It does not copy dirty or ignored files, secrets, or run setup scripts.

The first binding remains the primary repository. One thread cannot select two checkouts with the same Git common directory. Separate clones remain separate repositories.

Preparation shows each result. Retry failed bindings after repairing their specific problem. Cancellation retains any created worktrees. The fork does not automatically delete manifest checkouts, even after archiving or deleting a thread. Inspect and clean them manually when safe.

Use the All repositories view or a repository filter to inspect working changes and branch diffs. Each repository has its own file search, file editor, terminal, Commit, Push, and Create PR controls. Paths are qualified by the binding. A file changed since opening must be reloaded before saving. Git operation receipts prevent automatic replay after an uncertain result; inspect the checkout and remote before starting a new operation.

Repository membership is frozen after the first native provider session. This release does not yet verify changing an existing native session's roots safely. Missing checkouts, changed branches, or active Git operations block continuation. Repair the recorded checkout explicitly; the fork will not substitute the source directory.

Claude and Codex have multi-root adapter paths. Other providers retain single-repository use and are refused for a multi-repository thread. Full-access mode can access more than these folders. The manifest is not a security boundary in that mode. Additional leaf paths do not grant shared Git metadata automatically in a sandbox.

Whole-workspace file restore and whole-turn/thread checkpoint diff views are disabled for multi-repository threads. Working and branch diffs remain available. Eligible conversation-only rewind leaves files changed. Single-repository behavior retains the upstream recovery path.

## CI and conflict tasks

Resolve CI and Resolve conflicts insert an editable task into the current thread. They do not create a thread, prepare a checkout, submit a message, or run Git. **Open in new thread** is an explicit menu option. From a global PR page, choose a destination first. Checkout remains a separate explicit action.

For multiple repositories or PRs, select the target. Review any branch, commit, repository, or host mismatch before sending. PR identity includes host, repository, number, and head commit. A changed head invalidates prepared context.

The context collector includes check names, descriptions, run links, timestamps, and missing-data notices. It currently does not collect CI log bodies. Host-reported PR conflicts and actual local unmerged files are separate observations. Logs, comments, descriptions, and filenames are untrusted text.

## Remote clients

Use the fork's bundled responsive web client with a matching fork server. The fork protocol is **1002**; this differs from upstream protocol 2. Official desktop, hosted web, and native mobile clients are incompatible with this protocol. Do not use them as a fallback for these features.

Direct pairing, Tailscale Serve, authorization, and connection identity use the inherited transport. A local two-client/restart test does not prove remote-device operation. Real-device Tailscale workflows, sleep/wake, network changes, Connect, mobile notifications, native callbacks, and operating-system integrations remain unverified in this release. No owned Connect or push service is supplied.
