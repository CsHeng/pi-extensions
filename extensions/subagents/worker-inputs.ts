import { inspectGitWorkspace, type GitTaskWorkspace } from "./git-workspace.ts";
import { ManagedError } from "./session-contracts.ts";

export type WorkerInputState = { version: 2; gitWorkspace: GitTaskWorkspace };

export function workerGitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env = Object.fromEntries(Object.entries(source).filter(([name]) => !name.startsWith("GIT_")));
	return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}

export function initialWorkerInputs(gitWorkspace: GitTaskWorkspace): WorkerInputState {
	return { version: 2, gitWorkspace };
}

/** Source/worktree ownership only. Language tools own ignored environments. */
export async function inspectWorkerInputs(source: string, state: WorkerInputState): Promise<void> {
	if (state.version !== 2) throw new ManagedError("unsupported_worker_inputs");
	if (!state.gitWorkspace || state.gitWorkspace.path !== source) throw new ManagedError("managed_workspace_mismatch");
	await inspectGitWorkspace(state.gitWorkspace);
}

export async function prepareWorkerInputs(repo: string, source: string, gitWorkspace: GitTaskWorkspace): Promise<WorkerInputState> {
	if (gitWorkspace.repo !== repo) throw new ManagedError("managed_workspace_mismatch");
	const state = initialWorkerInputs(gitWorkspace);
	await inspectWorkerInputs(source, state);
	return state;
}

export async function refreshWorkerInputs(repo: string, source: string, previous: WorkerInputState): Promise<WorkerInputState> {
	await inspectWorkerInputs(source, previous);
	return prepareWorkerInputs(repo, source, previous.gitWorkspace);
}
