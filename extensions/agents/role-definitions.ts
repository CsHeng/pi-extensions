import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentCapabilities {
	message: string[];
	roster: boolean;
	invoke: boolean;
}

export interface AgentRoleDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	source: "package" | "user" | "project";
	may: AgentCapabilities;
	workspace: "shared" | "isolated";
	fallbackRoute?: string;
}

export const ROLE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const PACKAGE_ROLES = fileURLToPath(new URL("../../config/roles/", import.meta.url));
const MAX_ROLE_FILES = 64;
const MAX_ROLE_BYTES = 64 * 1024;

function fields(value: unknown, allowed: readonly string[], owner: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${owner} must be a mapping`);
	if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${owner} contains an unsupported field`);
	return value as Record<string, unknown>;
}

export function parseRoleDefinition(text: string, source: AgentRoleDefinition["source"], file: string): AgentRoleDefinition {
	if (Buffer.byteLength(text) > MAX_ROLE_BYTES) throw new Error("role file exceeds 64 KiB");
	let parsed: ReturnType<typeof parseFrontmatter>;
	try {
		parsed = parseFrontmatter(text);
	} catch {
		// Pi's YAML parser can include source text in errors. Only report the kind of problem.
		throw new Error("invalid role frontmatter YAML");
	}
	const { name, description, workspace = "shared", may = {}, fallbackRoute } = fields(
		parsed.frontmatter, ["name", "description", "workspace", "may", "fallbackRoute"], "role frontmatter",
	);
	if (typeof name !== "string" || !ROLE_NAME_PATTERN.test(name)) throw new Error("invalid role name");
	if (basename(file) !== `${name}.md`) throw new Error("role name must match the filename");
	if (typeof description !== "string" || description.trim() === "") throw new Error("role description must be nonempty text");
	if (parsed.body.trim() === "") throw new Error("role system prompt must be nonempty Markdown");
	if (workspace !== "shared" && workspace !== "isolated") throw new Error("role workspace must be shared or isolated");
	if (fallbackRoute !== undefined && (typeof fallbackRoute !== "string" || !ROLE_NAME_PATTERN.test(fallbackRoute))) {
		throw new Error("fallbackRoute must be a role name");
	}
	const { message = [], roster = false, invoke = false } = fields(may, ["message", "roster", "invoke"], "role may");
	if (!Array.isArray(message) || !message.every(target => typeof target === "string" && ROLE_NAME_PATTERN.test(target))) {
		throw new Error("role may.message must be an array of assigner, peers, or agent names");
	}
	if (typeof roster !== "boolean" || typeof invoke !== "boolean") throw new Error("role may.roster and may.invoke must be booleans");
	return {
		name,
		description: description.trim(),
		systemPrompt: parsed.body,
		source,
		may: { message: [...message], roster, invoke },
		workspace,
		...(fallbackRoute === undefined ? {} : { fallbackRoute }),
	};
}

async function readRoleFile(file: string): Promise<string> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("role file must be a regular non-symlink file");
		if (info.size > MAX_ROLE_BYTES) throw new Error("role file exceeds 64 KiB");
		// Bound reads even when a file grows after the size check.
		const buffer = Buffer.alloc(MAX_ROLE_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
			if (bytesRead === 0) break;
			size += bytesRead;
		}
		if (size > MAX_ROLE_BYTES) throw new Error("role file exceeds 64 KiB");
		return buffer.toString("utf8", 0, size);
	} finally {
		await handle.close();
	}
}

export async function loadRoleDefinitions(options: { agentDir: string; projectRoot?: string; trusted: boolean }): Promise<{
	roles: Map<string, AgentRoleDefinition>;
	problems: Array<{ file: string; reason: string }>;
}> {
	const roles = new Map<string, AgentRoleDefinition>();
	const problems: Array<{ file: string; reason: string }> = [];
	const sources: Array<[AgentRoleDefinition["source"], string]> = [["package", PACKAGE_ROLES], ["user", join(options.agentDir, "agent-roles")]];
	if (options.trusted && options.projectRoot !== undefined) sources.push(["project", join(options.projectRoot, ".pi", "agent-roles")]);
	for (const [source, directory] of sources) {
		try {
			let count = 0;
			for await (const entry of await opendir(directory)) {
				if (!entry.name.endsWith(".md")) continue;
				if (count === MAX_ROLE_FILES) {
					problems.push({ file: directory, reason: "role source exceeds 64 Markdown entries" });
					break;
				}
				count++;
				const file = join(directory, entry.name);
				try {
					if (!entry.isFile()) throw new Error("role file must be a regular non-symlink file");
					const role = parseRoleDefinition(await readRoleFile(file), source, file);
					roles.set(role.name, role);
				} catch (error) {
					problems.push({ file, reason: error instanceof Error ? error.message : "could not load role file" });
				}
			}
		} catch (error) {
			const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
			if (!missing || source === "package") problems.push({ file: directory, reason: "could not read role directory" });
		}
	}
	return { roles, problems };
}
