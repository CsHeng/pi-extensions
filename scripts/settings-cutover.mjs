#!/usr/bin/env node
import { constants } from "node:fs";
import { chmod, copyFile, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

function digest(value) {
	return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

async function readSettings(path) {
	const metadata = await lstat(path);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error("settings target must be one regular non-linked file");
	const source = await readFile(path, "utf8");
	const parsed = JSON.parse(source);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("settings root must be an object");
	return { metadata, source, parsed };
}

function summary(parsed, source, excludedNamespaces = []) {
	const preserved = structuredClone(parsed);
	delete preserved.packages;
	for (const namespace of excludedNamespaces) delete preserved[namespace];
	return { status: "ok", sha256: digest(source), topLevelKeysSha256: digest(Object.keys(parsed).sort()), preservedSha256: digest(preserved), packageCount: Array.isArray(parsed.packages) ? parsed.packages.length : 0 };
}

async function atomicWrite(path, parsed, mode) {
	return atomicWriteSource(path, `${JSON.stringify(parsed, null, 2)}\n`, mode);
}

async function atomicWriteSource(path, source, mode) {
	const temporary = join(dirname(path), `.workflow-settings-${process.pid}-${Date.now()}`);
	try {
		await writeFile(temporary, source, { mode, flag: "wx" });
		await rename(temporary, path);
		await chmod(path, mode);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

const [command, settingsPath, ...args] = process.argv.slice(2);
if (!command || !settingsPath) throw new Error("usage: settings-cutover.mjs baseline|apply|verify|restore <settings> ...");

if (command === "baseline") {
	const [backupPath, ...excludedNamespaces] = args;
	if (!backupPath) throw new Error("baseline requires a private backup path");
	const { metadata, source, parsed } = await readSettings(settingsPath);
	await copyFile(settingsPath, backupPath, constants.COPYFILE_EXCL);
	await chmod(backupPath, 0o600);
	process.stdout.write(`${JSON.stringify({ ...summary(parsed, source, excludedNamespaces), mode: metadata.mode & 0o777, backupSha256: digest(await readFile(backupPath)) })}\n`);
} else if (command === "apply") {
	const [oldPackage, newPackage, oldNamespace, newNamespace] = args;
	if (!oldPackage || !newPackage || !oldNamespace || !newNamespace) throw new Error("apply requires old/new package and namespace names");
	const { metadata, parsed } = await readSettings(settingsPath);
	if (!Array.isArray(parsed.packages) || parsed.packages.filter((item) => item === oldPackage).length !== 1 || parsed.packages.includes(newPackage)) throw new Error("package replacement precondition failed");
	if (!(oldNamespace in parsed) || newNamespace in parsed) throw new Error("namespace replacement precondition failed");
	parsed.packages = parsed.packages.map((item) => item === oldPackage ? newPackage : item);
	delete parsed[oldNamespace];
	parsed[newNamespace] = { version: 1, mode: "managed", policy: "default-deny" };
	await atomicWrite(settingsPath, parsed, metadata.mode & 0o777);
	const current = await readSettings(settingsPath);
	process.stdout.write(`${JSON.stringify(summary(current.parsed, current.source, [oldNamespace, newNamespace]))}\n`);
} else if (command === "verify") {
	const [expectedPackage, expectedNamespace, ...excludedNamespaces] = args;
	const { source, parsed } = await readSettings(settingsPath);
	if (!expectedPackage || !expectedNamespace || !Array.isArray(parsed.packages) || parsed.packages.filter((item) => item === expectedPackage).length !== 1) throw new Error("installed package verification failed");
	const harness = parsed[expectedNamespace];
	if (JSON.stringify(harness) !== JSON.stringify({ version: 1, mode: "managed", policy: "default-deny" })) throw new Error("installed namespace verification failed");
	process.stdout.write(`${JSON.stringify(summary(parsed, source, [expectedNamespace, ...excludedNamespaces]))}\n`);
} else if (command === "restore") {
	const [backupPath] = args;
	if (!backupPath) throw new Error("restore requires the private backup path");
	const current = await readSettings(settingsPath);
	const backup = await readSettings(backupPath);
	await atomicWriteSource(settingsPath, backup.source, current.metadata.mode & 0o777);
	const restored = await readSettings(settingsPath);
	if (digest(restored.source) !== digest(backup.source)) throw new Error("settings restoration digest mismatch");
	process.stdout.write(`${JSON.stringify(summary(restored.parsed, restored.source))}\n`);
} else {
	throw new Error("unknown settings cutover command");
}
