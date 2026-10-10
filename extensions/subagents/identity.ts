import { randomBytes } from "node:crypto";

/** Lowercase alphanumeric product identity. No punctuation, prefix, episode, or case folding. */
export const PRODUCT_ID = /^[A-Za-z0-9]{1,128}$/;
export const MINTED_ID = /^[a-z0-9]{32}$/;

export function isProductId(value: string): boolean {
	return PRODUCT_ID.test(value);
}

/** Standard random bytes, hex-encoded so the result has no punctuation. */
export function mintProductId(): string {
	return randomBytes(16).toString("hex");
}
