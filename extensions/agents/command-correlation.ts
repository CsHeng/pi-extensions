import { createHash } from "node:crypto";

/** Host call IDs are opaque bytes, not managed-session handles. */
export function commandCorrelationKey(value: unknown): string | null {
	if (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > 4096) return null;
	return createHash("sha256").update("csheng-worker-command-v2\0").update(value, "utf8").digest("hex");
}
