/**
 * Native source registry — explicit adapters only (no auto-registration of
 * generic providers). Local probes never touch the network.
 */
import { probeCommand, probePythonImport } from "../probe.js";
import { readBoundedText, fetchWithRedirectValidation } from "../http.js";
import { timeoutSignal } from "../utils.js";
import { accessSync, constants } from "node:fs";
import type { SourceDescriptor } from "./types.js";

function hostMatches(url: string, ...domains: string[]): boolean {
	let host: string;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
		if (parsed.username || parsed.password) return false;
		host = parsed.hostname.toLowerCase().replace(/\.$/, "");
	} catch {
		return false;
	}
	if (!host) return false;
	return domains.some((d) => {
		const allowed = d.toLowerCase().replace(/^\.+|\.+$/g, "");
		return host === allowed || host.endsWith(`.${allowed}`);
	});
}

function findOnPath(cmd: string): boolean {
	const pathEnv = process.env.PATH ?? "";
	const sep = process.platform === "win32" ? ";" : ":";
	for (const dir of pathEnv.split(sep)) {
		if (!dir) continue;
		try {
			accessSync(`${dir}/${cmd}`, constants.X_OK);
			return true;
		} catch {
			// continue
		}
	}
	return false;
}

const YOUTUBE_LIVE_TARGET =
	"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=aqz-KE-bpKQ&format=json";

const duckduckgo: SourceDescriptor = {
	id: "duckduckgo",
	label: "DuckDuckGo (local ddgs)",
	operations: ["search"],
	probe: async () => {
		const r = await probePythonImport("ddgs");
		if (r.status === "ok") return { status: "ok", message: "Python ddgs import works" };
		if (r.status === "missing")
			return {
				status: "off",
				message: "Python ddgs package not importable",
				remedy: "Install with: pip3 install ddgs",
			};
		return {
			status: "error",
			message: `ddgs probe ${r.status}: ${r.hint || r.output || r.status}`,
			remedy: "Reinstall ddgs: pip3 install --force-reinstall ddgs",
		};
	},
};

const youtube: SourceDescriptor = {
	id: "youtube",
	label: "YouTube captions (yt-dlp, optional)",
	operations: ["read"],
	matchesUrl: (url) => hostMatches(url, "youtube.com", "youtu.be"),
	probe: async () => {
		const r = await probeCommand("yt-dlp", ["--version"], { timeoutMs: 10_000, package: "yt-dlp" });
		if (r.status === "missing")
			return {
				status: "off",
				message: "yt-dlp not on PATH (optional dependency)",
				remedy: 'Install with: pipx install "yt-dlp[default]" (doctor reports readiness only)',
			};
		if (r.status === "broken") return { status: "error", message: "yt-dlp broken", remedy: r.hint };
		if (r.status !== "ok")
			return { status: "error", message: `yt-dlp probe ${r.status}: ${r.hint || r.output}` };
		const hasDeno = findOnPath("deno");
		const hasNode = findOnPath("node");
		if (!hasDeno && !hasNode)
			return {
				status: "warn",
				message: `yt-dlp ${r.output.split("\n")[0]} works but no JS runtime (deno/node) found — YouTube extraction needs one`,
				remedy: "Install Node.js or Deno",
			};
		return { status: "ok", message: `yt-dlp ${r.output.split("\n")[0]} executable` };
	},
	liveTarget: YOUTUBE_LIVE_TARGET,
	liveCheck: async (signal) => {
		const target = YOUTUBE_LIVE_TARGET;
		try {
			const { response } = await fetchWithRedirectValidation(
				target,
				{ signal: timeoutSignal(signal, 15_000), headers: { Accept: "application/json" } },
				3,
			);
			if (!response.ok) return { ok: false, target, message: `HTTP ${response.status}` };
			const body = await readBoundedText(response, 64 * 1024, target);
			if (!body.includes("title")) return { ok: false, target, message: "unexpected oEmbed body" };
			return { ok: true, target, message: "YouTube oEmbed reachable" };
		} catch (err) {
			return { ok: false, target, message: (err as Error).message.slice(0, 200) };
		}
	},
};

const rss: SourceDescriptor = {
	id: "rss",
	label: "RSS/Atom feeds (PR3)",
	operations: ["read"],
	probe: async () => ({
		status: "off",
		message: "RSS reader not implemented yet",
		remedy: "Lands in PR3 — use Jina/Defuddle for feed URLs meanwhile",
	}),
};

const ALL: SourceDescriptor[] = [duckduckgo, youtube, rss];

export function getSource(id: string): SourceDescriptor | undefined {
	return ALL.find((s) => s.id === id);
}

export function getAllSources(): SourceDescriptor[] {
	return [...ALL];
}
