import type { FileHandle } from "node:fs/promises";
import { MANAGED_LIMITS, ManagedError } from "./session-contracts.ts";

/** Incremental native JSONL decoding: bounded line buffers, no cumulative history cutoff. */
export async function* nativeLines(file: FileHandle, start = 0): AsyncGenerator<Record<string, unknown>> {
	const chunk = Buffer.alloc(64 * 1024);
	let pending = Buffer.alloc(0);
	let position = start;
	for (;;) {
		const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
		if (!bytesRead) break;
		position += bytesRead;
		const data = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
		let offset = 0;
		for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, offset)) {
			if (end - offset > MANAGED_LIMITS.maxNativeLineBytes) throw new ManagedError("managed_native_limit");
			let entry: unknown;
			try { entry = JSON.parse(data.subarray(offset, end).toString("utf8")); }
			catch { throw new ManagedError("managed_native_invalid", undefined, "parse"); }
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ManagedError("managed_native_invalid", undefined, "shape");
			yield entry as Record<string, unknown>;
			offset = end + 1;
		}
		pending = Buffer.from(data.subarray(offset));
		if (pending.length > MANAGED_LIMITS.maxNativeLineBytes) throw new ManagedError("managed_native_limit");
	}
	if (pending.length) throw new ManagedError("managed_native_incomplete");
}
