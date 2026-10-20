import type { BashOperations } from "@earendil-works/pi-coding-agent";

export interface FakeBashExecution {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv | undefined;
	aborted: boolean;
	/** Deliver combined stdout/stderr data exactly as the native operations do. */
	emit(text: string): void;
	/** Settle the native operation promise with the command's exit code. */
	close(exitCode: number | null): void;
	/** Settle the native operation promise with a spawn/abort failure. */
	fail(message: string): void;
}

/**
 * Controllable stand-in for Pi's local bash operations. It keeps the seam's
 * contract (`onData`, `signal`, returned exit code) without starting a process,
 * so timing and lifecycle assertions do not pin a second process backend.
 */
export function fakeBashOperations(options?: {
	onExec?: (execution: FakeBashExecution) => void;
	onAbort?: (execution: FakeBashExecution) => void;
}): { operations: BashOperations; executions: Map<string, FakeBashExecution> } {
	const executions = new Map<string, FakeBashExecution>();
	const operations: BashOperations = {
		exec(command, cwd, { onData, signal, env }) {
			let settle: { resolve: (value: { exitCode: number | null }) => void; reject: (error: Error) => void } | undefined;
			const execution: FakeBashExecution = {
				command,
				cwd,
				env,
				aborted: false,
				emit(text: string) { onData(Buffer.from(text)); },
				close(exitCode: number | null) { settle?.resolve({ exitCode }); },
				fail(message: string) { settle?.reject(new Error(message)); },
			};
			executions.set(command, execution);
			const settled = new Promise<{ exitCode: number | null }>((resolve, reject) => {
				settle = { resolve, reject };
			});
			signal?.addEventListener("abort", () => {
				execution.aborted = true;
				options?.onAbort?.(execution);
			}, { once: true });
			options?.onExec?.(execution);
			return settled;
		},
	};
	return { operations, executions };
}
