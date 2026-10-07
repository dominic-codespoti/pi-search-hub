/**
 * Tests for capability diagnostics — arg parsing, local-only default,
 * and failure isolation. Default report runs local probes only (no
 * network); live checks are never exercised here.
 */
import { describe, it, expect } from "vitest";
import {
	parseDoctorArgs,
	getDoctorReport,
	formatDoctorReport,
	clearDoctorCache,
} from "./capabilities.js";

describe("parseDoctorArgs", () => {
	it("parses empty args", () => {
		expect(parseDoctorArgs("")).toEqual({ live: false, source: undefined, refresh: false });
	});

	it("parses --live --source id", () => {
		expect(parseDoctorArgs("--live --source youtube")).toEqual({
			live: true,
			source: "youtube",
			refresh: false,
		});
	});

	it("parses --source=id and --refresh", () => {
		expect(parseDoctorArgs("--source=rss --refresh")).toEqual({
			live: false,
			source: "rss",
			refresh: true,
		});
	});
});

describe("getDoctorReport", () => {
	it("returns a local report without network by default", async () => {
		clearDoctorCache();
		const report = await getDoctorReport(
			{ defaultBackend: "duckduckgo", backends: {} },
			["duckduckgo"],
			{ refresh: true },
		);
		expect(report.scope).toBe("local");
		expect(report.backends).toEqual(["duckduckgo"]);
		expect(report.sources.map((s) => s.id).sort()).toEqual(["duckduckgo", "rss", "youtube"]);
		for (const s of report.sources) {
			expect(["ok", "warn", "off", "error"]).toContain(s.status);
			expect(s.message.length).toBeGreaterThan(0);
			expect(s.live).toBeUndefined();
		}
		const text = formatDoctorReport(report);
		expect(text).toContain("## Search Doctor");
		expect(text).toContain("Scope: local");
	});

	it("rejects --live without a source", async () => {
		await expect(
			getDoctorReport({ defaultBackend: "duckduckgo", backends: {} }, ["duckduckgo"], {
				live: true,
				refresh: true,
			}),
		).rejects.toThrow(/explicit source/);
	});

	it("rejects unknown sources", async () => {
		await expect(
			getDoctorReport({ defaultBackend: "duckduckgo", backends: {} }, ["duckduckgo"], {
				source: "twitter",
				refresh: true,
			}),
		).rejects.toThrow(/Unknown source/);
	});

	it("returns cached reports within TTL", async () => {
		clearDoctorCache();
		const opts = { refresh: true } as const;
		const first = await getDoctorReport(
			{ defaultBackend: "duckduckgo", backends: {} },
			["duckduckgo"],
			opts,
		);
		const second = await getDoctorReport(
			{ defaultBackend: "duckduckgo", backends: {} },
			["duckduckgo"],
			{},
		);
		expect(second.checkedAt).toBe(first.checkedAt);
	});
});
