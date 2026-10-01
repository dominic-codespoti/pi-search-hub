/**
 * Tests for web_search query fan-out (queries=[...] variations).
 * The registry is mocked; merging, dedupe, caps and stats are exercised
 * through the real tool. Single-query behavior is covered by
 * search-hub.test.ts and must stay identical.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", async () => {
	const { Type } = await import("typebox");
	return { StringEnum: (values: string[]) => Type.Union(values.map(value => Type.Literal(value))) };
});

const { runBackendMock } = vi.hoisted(() => ({ runBackendMock: vi.fn() }));
vi.mock("./backends/registry.js", () => ({
	BACKEND_DEFS: { duckduckgo: { label: "duckduckgo" } },
	runBackend: runBackendMock,
}));

import searchHub from "./search-hub.js";
import { refreshConfig } from "./config.js";
import { FALLBACK_ENV_MAP } from "./credentials.js";

describe("web_search fan-out", () => {
	let root: string;
	let tool: any;
	let ctx: any;
	let signal: AbortSignal;

	const resultsFor = (query: string) => [
		{ title: `${query} A`, url: `https://example.com/${query}-a`, snippet: "s" },
		{ title: `${query} B`, url: `https://example.com/${query}-b`, snippet: "s" },
		{ title: "shared", url: "https://example.com/shared", snippet: "s" },
	];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-search-fanout-"));
		mkdirSync(join(root, "extensions"));
		writeFileSync(join(root, "extensions", "search.json"), JSON.stringify({
			defaultBackend: "auto",
			selectionStrategy: "sequential",
			backends: { duckduckgo: { enabled: true } },
		}));
		vi.stubEnv("PI_CODING_AGENT_DIR", root);
		for (const name of Object.values(FALLBACK_ENV_MAP)) vi.stubEnv(name, undefined);
		signal = new AbortController().signal;
		ctx = { cwd: root, hasUI: false, modelRegistry: {}, ui: { setStatus: vi.fn() } };
		runBackendMock.mockReset();
		runBackendMock.mockImplementation(async (_backend: string, query: string) => resultsFor(query));
		searchHub({
			registerTool: (registered: any) => { if (registered.name === "web_search") tool = registered; },
			registerCommand: vi.fn(),
			on: vi.fn(),
		} as any);
		refreshConfig(root, true);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	const search = (params: Record<string, unknown>) =>
		tool.execute("call", { query: "primary", numResults: 4, ...params }, signal, undefined, ctx);

	it("merges variations, dedupes by URL and caps at numResults", async () => {
		const result = await search({ queries: ["alpha", "beta"] });

		expect(result.details.backend).toBe("fanout");
		expect(result.details.queryCount).toBe(3);
		expect(result.details.resultCount).toBeLessThanOrEqual(4);
		// 3 queries x 3 results with 1 shared URL = 7 unique; capped at 4
		expect(result.details.resultCount).toBe(4);
		expect(result.details.perQuery).toEqual([
			{ query: "primary", backend: "duckduckgo", count: 3 },
			{ query: "alpha", backend: "duckduckgo", count: 3 },
			{ query: "beta", backend: "duckduckgo", count: 3 },
		]);
		// Merged text contains results from multiple variations
		expect(result.content[0].text).toContain("primary A");
	});

	it("dedupes blank and repeated variations before running", async () => {
		await search({ queries: ["alpha", "  ", "primary", "alpha"] });

		const seenQueries = runBackendMock.mock.calls.map((c: unknown[]) => c[1]);
		expect(seenQueries).toEqual(["primary", "alpha"]);
	});

	it("rejects more than 4 variations before any backend call", async () => {
		await expect(search({ queries: ["a", "b", "c", "d", "e"] })).rejects.toThrow(/Too many queries/);
		expect(runBackendMock).not.toHaveBeenCalled();
	});

	it("survives one failing variation", async () => {
		runBackendMock.mockImplementation(async (_backend: string, query: string) => {
			if (query === "bad") throw new Error("backend blew up");
			return resultsFor(query);
		});

		const result = await search({ queries: ["bad", "good"] });

		expect(result.details.backend).toBe("fanout");
		expect(result.details.perQuery.find((p: any) => p.query === "bad").error).toMatch(/blew up/);
		expect(result.details.resultCount).toBeGreaterThan(0);
	});

	it("throws when every variation fails", async () => {
		runBackendMock.mockRejectedValue(new Error("all down"));

		await expect(search({ queries: ["x"] })).rejects.toThrow(/Fan-out found no results/);
	});

	it("single query keeps the historic details shape", async () => {
		const result = await search({});

		expect(result.details.backend).toBe("duckduckgo");
		expect(result.details.perQuery).toBeUndefined();
		expect(result.details.resultCount).toBe(3);
	});
});
