# J4 Code (Unofficial)

J4 Code is a personal fork of T3 Code. This build adds quick actions, repository bindings in one thread, and PR tasks that stay in the current thread. It is a development build. Check the [release verification record](../fork/acceptance-status.json) before using it for daily work.

## Keep the official installation separate

The macOS app is **J4 Code (Unofficial)**. Its app ID is `dev.joaoheusi.j4code`. Its default data directory is `~/.j4code`; its Electron profile is `~/Library/Application Support/j4code`. The official application and its data remain separate.

The fork reads `J4CODE_HOME` for a custom data directory. It ignores the official `T3CODE_HOME` setting. Do not point the fork at the official profile. Initial updates are manual. The desktop updater, CLI updater, and server updater cannot replace this fork with an official release.

Keep the official application available while testing this build. To return to it, close J4 Code and open the official application. Do not copy the fork's migrated database back into the official profile.

## Quick actions

Quick actions are saved instructions you insert into a thread's composer. Type `/` in the composer to see them next to the other commands, or press **⌘G** (**Ctrl+G** on Windows and Linux) anywhere in a thread. They also appear when you search the command palette (**⌘K**). Inserting never sends; you review the text first. For actions that target pull requests or several repositories, select one or more items, then choose **Insert selected**. Pull request choices show CI and conflict status.

On mobile, choose **Quick actions** above the composer to insert an action. Open **Manage quick actions** there to create or edit actions, choose their project scope, or remove them.

The quick action menu also offers **Merge pull requests**. Select the PRs, choose a merge method allowed by every selected repository, and confirm. This runs the merge command directly.

Manage the library in **Settings → Quick actions**: create, edit, duplicate, favorite, disable, delete, import, and export. Give an action its own shortcut in its editor. Actions belong to one machine and can be limited to one project there. Anyone who can read that machine's settings can read them, so keep secrets out of templates.

Templates can use variables. `{{date}}`, `{{time}}`, and `{{clipboard}}` come from your device. `{{thread.title}}`, `{{workspace.repositories}}`, `{{repo.name}}`, `{{repo.path}}`, `{{repo.branch}}`, `{{pr.url}}`, `{{ci.failures}}`, and `{{pr.conflicts}}` come from the thread's machine. An action that needs a pull request or repository asks which one when the thread has several, and explains what is missing when it has none. Write `\{{` for literal braces.

On web and desktop, if the draft changes while an action gathers context, or you move to another thread, the text waits in a notice above that thread's composer. Choose **Insert** to add it to the end of the draft. On mobile, a changed draft keeps its text and asks you to select the action again.

Import accepts the Quick Actions app's JSON format. Imports are added as copies without shortcuts. Export skips actions that use thread, repository, or pull request variables, because only this app can fill them.

## Several repositories in one thread

On mobile, use **Add folders** in a new task to select repositories from the connected machine. Folder projects discover their repositories automatically. You can choose current checkouts or new worktrees and save the selection as the project default. An existing thread’s repository list shows preparation progress and lets you retry failed setup. Repository choices are fixed after you queue the task.

Before a thread's first message, choose its repositories with the repositories button next to the workspace and branch controls under the composer. Pick from this machine's projects, or browse to any folder; a folder that isn't a repository is searched for repositories inside it. Each added repository uses its **Current checkout** or a **New worktree** from its current branch. Adding a linked worktree folder uses that **Existing worktree**. The thread's own project follows the workspace and branch controls.

To start every new thread in a project with the same repositories, choose **Save as project default** in that menu. **Clear project default** there, or the reset beside **Repositories** in the project's settings, goes back to the project alone.

### Folder projects

A project whose folder isn't a repository but holds repositories is a folder project. Its new threads start with every repository found up to three folders deep, at most 20; remove the ones you don't need. Repositories nested inside another one, and extra checkouts of the same repository, are left out. The folder row in the menu chooses where the agent works:

- **Current folder** works in the folder itself.
- **New worktrees** makes a copy of the folder's layout with a new worktree of each repository at the same place, so paths between them still work. Each worktree starts from its repository's default branch, such as `main`, whatever branch the original checkout is on. A repository with no known default branch, such as one without an `origin` remote, starts from its checkout's branch. Files outside the repositories, such as a shared script at the top of the folder, aren't copied.

The folder's mode also follows the project's default workspace setting. Repositories outside the folder can still be added with their own checkout.

### Preparing and working

When you send, the repositories are prepared first and your message sends once they are ready. A notice above the composer shows progress and lets you cancel or retry. New worktrees start from the latest commit; uncommitted and ignored files stay where they are. Worktrees created for a thread are not deleted automatically.

After the first message, the repository list is fixed. Open the thread details panel to see each repository's branch, changes, and pull request, and to open a terminal there, copy its path, or show its changes. The repository you select there is the one the diff panel, **Open in**, and the commit, push, and pull request controls act on, and its pull requests show under its branch; the diff panel also has a repository menu. After each turn, a pull request on any repository's branch is linked to the thread, whether the agent or you opened it. Unlinking one keeps it off the thread. Turn diffs and whole-thread file restore cover only the thread's own project, and a folder project has none. The files panel also shows only the thread's own project or folder; open other repositories with **Open in**.

Repositories can change branch or go through a merge or rebase during the thread. Sending stops only if a checkout disappears or becomes a different repository.

Claude and Codex can work across repositories outside the thread's folder. Other providers can only work in a folder project whose repositories are all inside it. In full-access mode an agent can reach more than these folders.

## CI and conflict tasks

**Fix** and **Resolve** on a pull request in the thread details panel draft a task in this thread's composer, with the failing checks or conflict state attached. Nothing is sent and no checkout changes. Use the menu next to them to work in a new thread instead. From the pull requests page, you pick the thread first.

The text of these tasks is your **Resolve CI** and **Resolve merge conflicts** quick actions, so editing those changes what the buttons insert. The attached context includes check names, descriptions, and run links, not full CI logs. Logs, comments, and filenames are untrusted text.

## Remote clients

Use the fork's bundled responsive web client with a matching fork server. The fork protocol is **1002**; this differs from upstream protocol 2. Official desktop, hosted web, and native mobile clients are incompatible with this protocol. Do not use them as a fallback for these features.

Direct pairing, Tailscale Serve, authorization, and connection identity use the inherited transport. A local two-client/restart test does not prove remote-device operation. Real-device Tailscale workflows, sleep/wake, network changes, Connect, mobile notifications, native callbacks, and operating-system integrations remain unverified in this release. No owned Connect or push service is supplied.
