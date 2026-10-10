/** In-process destination serialization. Disjoint keys overlap; shared keys wait in a stable order. */
const tails = new Map<string, Promise<void>>();

export async function withDestinationLocks(keys: readonly string[], action: () => Promise<void>): Promise<void> {
	const ordered = [...new Set(keys)].sort();
	const releases: Array<() => void> = [];
	try {
		for (const key of ordered) {
			const previous = tails.get(key) ?? Promise.resolve();
			let release!: () => void;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			const tail = previous.then(() => gate, () => gate);
			tails.set(key, tail);
			releases.push(() => {
				release();
				if (tails.get(key) === tail) tails.delete(key);
			});
			await previous.catch(() => undefined);
		}
		await action();
	} finally {
		for (const release of releases.reverse()) release();
	}
}

export function destinationKey(dev: number, ino: number, path: string): string {
	return Number.isSafeInteger(dev) && Number.isSafeInteger(ino) ? `${dev}:${ino}` : path;
}
