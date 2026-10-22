import type { EnvironmentId } from "@t3tools/contracts";

import { createAtomCommandScheduler, type AtomCommandConcurrency } from "./runtime.ts";

export const vcsCommandScheduler = createAtomCommandScheduler();

type VcsCommandInput = {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly cwd: string };
};

const vcsCommandKey = ({ environmentId, input }: VcsCommandInput) =>
  JSON.stringify([environmentId, input.cwd]);

export const vcsCommandConcurrency: AtomCommandConcurrency<VcsCommandInput> = {
  mode: "serial",
  key: vcsCommandKey,
};

/** A status refresh waiting behind another lane command reads the same state, so later requests join it. */
export const vcsRefreshStatusConcurrency: AtomCommandConcurrency<VcsCommandInput> = {
  mode: "serial",
  key: vcsCommandKey,
  joinQueued: true,
};
