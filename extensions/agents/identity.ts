import { randomBytes } from "node:crypto";

export const PRODUCT_ID = /^[A-Za-z0-9]{1,128}$/;
export const MINTED_ID = /^[a-z0-9]{32}$/;

export function isProductId(value: string): boolean {
	return PRODUCT_ID.test(value);
}

export const TASK_LABEL = /\S/;

export function isTaskLabel(value: string): boolean {
	return value.length <= 64 && TASK_LABEL.test(value);
}

export function mintProductId(): string {
	return randomBytes(16).toString("hex");
}
