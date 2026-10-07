import { describe, expect, it } from "vite-plus/test";

import {
  publishComposerWorkspaceControl,
  useComposerWorkspaceControlStore,
} from "./composerWorkspaceControlStore";

const control = () => ({ activeWorktreePath: null, selectEnvMode: () => {} });

describe("publishComposerWorkspaceControl", () => {
  it("keeps a newer composer's control when an older one unpublishes", () => {
    const first = control();
    const second = control();
    const unpublishFirst = publishComposerWorkspaceControl(first);
    const unpublishSecond = publishComposerWorkspaceControl(second);

    unpublishFirst();
    expect(useComposerWorkspaceControlStore.getState().control).toBe(second);

    unpublishSecond();
    expect(useComposerWorkspaceControlStore.getState().control).toBeNull();
  });
});
