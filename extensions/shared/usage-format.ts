/** Token units and latest-prompt cache hit use the same meaning in main and agent views. */
export function formatTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export function promptCacheHit(input: number, cacheRead: number, cacheWrite: number): number | undefined {
	const total = input + cacheRead + cacheWrite;
	return Number.isFinite(total) && total > 0 ? cacheRead / total * 100 : undefined;
}
