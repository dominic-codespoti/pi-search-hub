/**
 * Capability diagnostics — shared implementation for `/search-doctor`.
 *
 * Default is local-only: enabled-backend configuration (no network) plus
 * side-effect-free local probes (fixed `--version`/import argv, bounded).
 * Network only when explicitly requested with a single source:
 * `/search-doctor --live --source youtube`. One throwing probe never
 * breaks the report; output is credential-safe (no keys echoed).
 */
import type { SearchConfig } from "./types.js";
import { getAllSources, getSource } from "./sources/registry.js";
import type { SourceStatus } from "./sources/types.js";

export interface DoctorSourceResult {
	id: string;
	label: string;
	status: SourceStatus;
	message: string;
	remedy?: string;
	live?: { ok: boolean; target: string; message: string };
}

export interface DoctorReport {
	checkedAt: string;
	scope: "local" | "live";
	backends: string[];
	sources: DoctorSourceResult[];
}

export interface DoctorOptions {
	live?: boolean;
	source?: string;
	refresh?: boolean;
	signal?: AbortSignal;
}

const CACHE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 15_000;
const cache = new Map<string, { at: number; report: DoctorReport }>();

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`${label} timed out (>${ms}ms)`)), ms);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			},
		);
	});
}

export function parseDoctorArgs(args: string): { live: boolean; source?: string; refresh?: boolean } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	let live = false;
	let refresh = false;
	let source: string | undefined;
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p === "--live") live = true;
		else if (p === "--refresh" || p === "--no-cache") refresh = true;
		else if (p === "--source" && i + 1 < parts.length) source = parts[++i];
		else if (p.startsWith("--source=")) source = p.slice("--source=".length) || undefined;
	}
	return { live, source, refresh };
}

export async function getDoctorReport(
	config: SearchConfig,
	activeBackends: string[],
	opts: DoctorOptions = {},
): Promise<DoctorReport> {
	if (opts.live && !opts.source) {
		throw new Error("Live checks require an explicit source: /search-doctor --live --source <id>");
	}
	const cacheKey = `live=${opts.live ? opts.source : ""}`;
	if (!opts.refresh) {
		const hit = cache.get(cacheKey);
		if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.report;
	}

	const sources = opts.source ? [getSource(opts.source)] : getAllSources();
	if (opts.source && !sources[0]) {
		const known = getAllSources().map((s) => s.id).join(", ");
		throw new Error(`Unknown source "${opts.source}". Known sources: ${known}`);
	}

	const results: DoctorSourceResult[] = await Promise.all(
		(sources as NonNullable<ReturnType<typeof getSource>>[]).map(async (src) => {
			try {
				const probed = await withTimeout(src.probe(), PROBE_TIMEOUT_MS, `${src.id} probe`);
				const entry: DoctorSourceResult = {
					id: src.id,
					label: src.label,
					status: probed.status,
					message: probed.message,
					remedy: probed.remedy,
				};
				if (opts.live) {
					if (!src.liveCheck) {
						entry.live = {
							ok: false,
							target: "",
							message: `No live check defined for source "${src.id}"`,
						};
					} else {
						try {
							const live = await withTimeout(
								src.liveCheck(opts.signal),
								20_000,
								`${src.id} live check`,
							);
							entry.live = live;
						} catch (err) {
							entry.live = {
								ok: false,
								target: src.liveTarget ?? "",
								message: (err as Error).message.slice(0, 200),
							};
						}
					}
				}
				return entry;
			} catch (err) {
				return {
					id: src.id,
					label: src.label,
					status: "error" as SourceStatus,
					message: `probe failed: ${(err as Error).message.slice(0, 200)}`,
				};
			}
		}),
	);

	const report: DoctorReport = {
		checkedAt: new Date().toISOString(),
		scope: opts.live ? "live" : "local",
		backends: [...activeBackends],
		sources: results,
	};
	cache.set(cacheKey, { at: Date.now(), report });
	return report;
}

const STATUS_ICON: Record<SourceStatus, string> = {
	ok: "✅",
	warn: "⚠️",
	off: "—",
	error: "❌",
};

export function formatDoctorReport(report: DoctorReport): string {
	const lines: string[] = [
		"## Search Doctor",
		`Scope: ${report.scope} (default makes no network requests; --live checks one explicit source)`,
		`Checked: ${report.checkedAt}`,
		`Enabled backends (configuration): ${report.backends.join(", ") || "none"}`,
		"",
	];
	for (const s of report.sources) {
		const icon = STATUS_ICON[s.status] ?? "?";
		lines.push(`${icon} ${s.label} [${s.id}]: ${s.message}`);
		if (s.remedy) lines.push(`   Remedy: ${s.remedy}`);
		if (s.live) {
			const li = s.live.ok ? "✅" : "❌";
			lines.push(
				`   Live ${li}: ${s.live.message}${s.live.target ? ` (${s.live.target})` : ""}`,
			);
		}
	}
	lines.push("");
	lines.push("A working binary is not proof that a particular page or video is readable.");
	return lines.join("\n");
}

export function clearDoctorCache(): void {
	cache.clear();
}
