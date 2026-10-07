/**
 * Local process probing — distinguish missing / broken / timeout / error.
 *
 * Ported from agent-reach `probe.py` (MIT): `shutil.which()` alone is not
 * proof of health — a stale venv shim passes which() but cannot execute.
 * Fixed argv only, never shell interpolation; bounded time and output.
 */
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export type ProbeStatus = "ok" | "missing" | "broken" | "timeout" | "error";

export interface ProbeResult {
	status: ProbeStatus;
	output: string;
	hint: string;
}

const OUTPUT_CAP = 4 * 1024;
const BROKEN_EXIT_CODES = new Set([126, 127]);

export function reinstallHint(pkg: string): string {
	return (
		`Command exists but cannot execute — usually a stale venv shim after a system Python upgrade. Reinstall: ` +
		`uv tool install --force ${pkg} or pipx reinstall ${pkg}`
	);
}

function findOnPath(cmd: string): string | null {
	if (cmd.includes("/")) {
		try {
			accessSync(cmd, constants.X_OK);
			return cmd;
		} catch {
			return null;
		}
	}
	const pathEnv = process.env.PATH ?? "";
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		const full = join(dir, cmd);
		try {
			accessSync(full, constants.X_OK);
			return full;
		} catch {
			// continue
		}
	}
	return null;
}

function truncate(s: string): string {
	return s.length > OUTPUT_CAP ? s.slice(0, OUTPUT_CAP) + "…[truncated]" : s;
}

/**
 * Execute a fixed side-effect-free command (typically `--version`) and
 * classify the result. No shell, no retries for missing/broken.
 */
export function probeCommand(
	cmd: string,
	args: string[] = ["--version"],
	opts: { timeoutMs?: number; package?: string } = {},
): Promise<ProbeResult> {
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const pkg = opts.package ?? cmd;
	const path = findOnPath(cmd);
	if (!path) return Promise.resolve({ status: "missing", output: "", hint: "" });

	return new Promise((resolve) => {
		const child = execFile(
			path,
			args,
			{ timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true },
			(error, stdout, stderr) => {
			if (error) {
				const nodeErr = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
				if (nodeErr.killed && (nodeErr.signal === "SIGTERM" || nodeErr.code === "ETIMEDOUT")) {
						resolve({ status: "timeout", output: "", hint: `\`${path}\` timed out (>${timeoutMs}ms)` });
						return;
					}
					if (nodeErr.code === "ENOENT" || nodeErr.code === "EACCES") {
						resolve({ status: "broken", output: "", hint: reinstallHint(pkg) });
						return;
					}
					const code = typeof nodeErr.code === "number" ? nodeErr.code : (error as { code?: number }).code;
					if (typeof code === "number" && BROKEN_EXIT_CODES.has(code)) {
						resolve({ status: "broken", output: "", hint: reinstallHint(pkg) });
						return;
					}
					const output = truncate(`${stdout ?? ""}${stderr ?? ""}`.trim());
					resolve({ status: "error", output, hint: output });
					return;
				}
				resolve({ status: "ok", output: truncate(`${stdout ?? ""}${stderr ?? ""}`.trim()), hint: "" });
			},
		);
		// Belt-and-braces: execFile timeout kills, but ensure abort on close leak.
		child.on("error", () => undefined);
	});
}

/** Probe a Python import without side effects: `python3 -c "import <mod>"`. */
export async function probePythonImport(
	module: string,
	pythonCmd = process.platform === "win32" ? "python" : "python3",
	timeoutMs = 10_000,
): Promise<ProbeResult> {
	const path = findOnPath(pythonCmd);
	if (!path) return { status: "missing", output: "", hint: "" };
	return new Promise((resolve) => {
		execFile(
			path,
			["-c", `import ${module}`],
			{ timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true },
			(error, stdout, stderr) => {
			if (error) {
				const nodeErr = error as NodeJS.ErrnoException & { killed?: boolean };
				if (nodeErr.killed) {
						resolve({ status: "timeout", output: "", hint: `python import ${module} timed out` });
						return;
					}
					if (nodeErr.code === "ENOENT" || nodeErr.code === "EACCES") {
						resolve({ status: "broken", output: "", hint: reinstallHint(pythonCmd) });
						return;
					}
					const output = truncate(`${stdout ?? ""}${stderr ?? ""}`.trim());
					resolve({ status: "missing", output, hint: output });
					return;
				}
				resolve({ status: "ok", output: "", hint: "" });
			},
		);
	});
}
