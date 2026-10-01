/**
 * Tests for reader dispatch — fetchWithFallback fallback orchestration.
 *
 * We mock fetchWithReader (same module) so fetchWithFallback's
 * retry/fallback logic can be tested in isolation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SearchConfig } from "../extensions/types.js";
import type { FetchResult } from "../extensions/readers/single.js";

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const mockFetchWithReader = vi.fn<(...args: unknown[]) => Promise<FetchResult>>();

vi.mock("../extensions/readers/single.js", () => ({
	fetchWithReader: mockFetchWithReader,
	readerLabel: (r: string) => r === "sofya" ? "Sofya" : r === "firecrawl" ? "Firecrawl" : r === "exa" ? "Exa" : r === "exa_mcp" ? "Exa MCP" : "Jina",
	FetchParams: {},
	FetchResult: {},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Thin-content gate disabled here so legacy short fixtures behave as before;
// the gate itself is covered by dedicated tests below.
const MINIMAL_CONFIG: SearchConfig = { defaultBackend: "duckduckgo", backends: {}, minContentChars: 0 };

function makeResult(content: string, reader: string): FetchResult {
	return { content, reader };
}

// ---------------------------------------------------------------------------
// fetchWithFallback
// ---------------------------------------------------------------------------

describe("fetchWithFallback", () => {
	beforeEach(() => {
		mockFetchWithReader.mockClear();
	});

	it("returns result from first reader on success", async () => {
		mockFetchWithReader.mockResolvedValueOnce(makeResult("hello from jina", "jina"));

		const { fetchWithFallback } = await import("../extensions/readers/dispatch.js");
		const result = await fetchWithFallback(
			"https://example.com",
			["jina", "sofya", "firecrawl"],
			{},
			undefined,
			MINIMAL_CONFIG,
		);

		expect(result.content).toBe("hello from jina");
		expect(result.reader).toBe("jina");
		expect(mockFetchWithReader).toHaveBeenCalledTimes(1);
	});

	it("falls through on 422 error to next reader", async () => {
		mockFetchWithReader
			.mockRejectedValueOnce(new Error("Failed to read https://example.com: API error (422): No content available for URL"))
			.mockResolvedValueOnce(makeResult("hello from sofya", "sofya"));

		const { fetchWithFallback } = await import("../extensions/readers/dispatch.js");
		const result = await fetchWithFallback(
			"https://example.com",
			["jina", "sofya", "firecrawl"],
			{},
			undefined,
			MINIMAL_CONFIG,
		);

		expect(result.content).toBe("hello from sofya");
		expect(result.reader).toBe("sofya");
		expect(mockFetchWithReader).toHaveBeenCalledTimes(2);
	});

	it("falls through on 5xx error", async () => {
		mockFetchWithReader
			.mockRejectedValueOnce(new Error("Failed to read https://example.com: API error (503): Service Unavailable"))
			.mockResolvedValueOnce(makeResult("hello from firecrawl", "firecrawl"));

		const { fetchWithFallback } = await import("../extensions/readers/dispatch.js");
		const result = await fetchWithFallback(
			"https://example.com",
			["jina", "firecrawl"],
			{},
			undefined,
			MINIMAL_CONFIG,
		);

		expect(result.content).toBe("hello from firecrawl");
		expect(result.reader).toBe("firecrawl");
		expect(mockFetchWithReader).toHaveBeenCalledTimes(2);
	});

	it("falls through on network error", async () => {
		mockFetchWithReader
			.mockRejectedValueOnce(new Error("fetch failed: connect ECONNREFUSED"))
			.mockResolvedValueOnce(makeResult("hello from exa_mcp", "exa_mcp"));

		const { fetchWithFallback } = await import("../extensions/readers/dispatch.js");
		const result = await fetchWithFallback(
			"https://example.com",
			["jina", "exa_mcp"],
			{},
			undefined,
			MINIMAL_CONFIG,
		);

		expect(result.content).toBe("hello from exa_mcp");
		expect(result.reader).toBe("exa_mcp");
	});

	it("does NOT fall through on 401 auth error", async () => {
		mockFetchWithReader.mockRejectedValueOnce(new Error("Failed to read https://example.com: API error (401): Unauthorized"));

		const { fetchWithFallback } = await import("../extensions/readers/dispatch.js");
		await expect(
			fetchWithFallback(
				"https://example.com",
				["jina", "sofya", "firecrawl"],
				{},
				undefined,
				MINIMAL_CONFIG,
			),
		).rejects.toThrow(/401/);

		// Only the first reader should be tried — no fallthrough on auth errors
		expect(mockFetchWithReader).toHaveBeenCalledTimes(1);
	});

	it("does NOT fall through on 403 auth error", async () => {
		mockFetchWithReader.mockRejectedValueOnce(new Error("Failed to read https://example.com: API error (403): Forbidden"));

		const { fetchWithFallback } = await import("../extensions/readers/dispatch.js");
		await expect(
			fetchWithFallback(
				"https://example.com",
				["jina", "sofya"],
				{},
				undefined,
				MINIMAL_CONFIG,
			),
		).rejects.toThrow(/403/);

		expect(mockFetchWithReader).toHaveBeenCalledTimes(1);
	});

	it("throws combined error when all readers fail with retryable errors", async () => {
		mockFetchWithReader
			.mockRejectedValueOnce(new Error("Failed to read https://example.com: API error (422): No content"))
			.mockRejectedValueOnce(new Error("Failed to read https://example.com: API error (503): Service Unavailable"))
			.mockRejectedValueOnce(new Error("fetch failed: timeout"));

		const { fetchWithFallback } = await import("../extensions/readers/dispatch.js");
		await expect(
			fetchWithFallback(
				"https://example.com",
				["jina", "sofya", "firecrawl"],
				{},
				undefined,
				MINIMAL_CONFIG,
			),
		).rejects.toThrow("All readers failed: jina: Failed to read https://example.com: API error (422): No content; sofya: Failed to read https://example.com: API error (503): Service Unavailable; firecrawl: fetch failed: timeout");

		expect(mockFetchWithReader).toHaveBeenCalledTimes(3);
	});

	it("calls onAttempt for each reader tried", async () => {
		mockFetchWithReader
			.mockRejectedValueOnce(new Error("Failed to read https://example.com: API error (422): No content"))
			.mockResolvedValueOnce(makeResult("hello from sofya", "sofya"));

		const onAttempt = vi.fn();
		const { fetchWithFallback } = await import("../extensions/readers/dispatch.js");

		await fetchWithFallback(
			"https://example.com",
			["jina", "sofya", "firecrawl"],
			{},
			undefined,
			MINIMAL_CONFIG,
			onAttempt,
		);

		// Called for jina (attempted, failed) and sofya (attempted, succeeded)
		// firecrawl was never reached
		expect(onAttempt).toHaveBeenCalledTimes(2);
		expect(onAttempt).toHaveBeenNthCalledWith(1, "jina", 0, 3);
		expect(onAttempt).toHaveBeenNthCalledWith(2, "sofya", 1, 3);
	});

	it("uses DEFAULT_READER_FALLBACK order when no config override", async () => {
		const { DEFAULT_READER_FALLBACK } = await import("../extensions/readers/dispatch.js");
		expect(DEFAULT_READER_FALLBACK).toEqual(["jina", "sofya", "firecrawl", "exa", "exa_mcp"]);
	});

	it("respects custom fallback order: Firecrawl first, then Jina", async () => {
		mockFetchWithReader
			.mockRejectedValueOnce(new Error("Failed to read: API error (422): No content"))
			.mockResolvedValueOnce(makeResult("hello from jina", "jina"));

		const { fetchWithFallback } = await import("../extensions/readers/dispatch.js");
		const result = await fetchWithFallback(
			"https://example.com",
			["firecrawl", "jina"],
			{},
			undefined,
			MINIMAL_CONFIG,
		);

		// Firecrawl tried first, failed; Jina tried second, succeeded
		expect(result.content).toBe("hello from jina");
		expect(result.reader).toBe("jina");
		expect(mockFetchWithReader).toHaveBeenCalledTimes(2);
		expect(mockFetchWithReader).toHaveBeenNthCalledWith(1, "https://example.com", "firecrawl", {}, undefined, MINIMAL_CONFIG);
		expect(mockFetchWithReader).toHaveBeenNthCalledWith(2, "https://example.com", "jina", {}, undefined, MINIMAL_CONFIG);
	});

	it("single-entry fallback never falls through", async () => {
		mockFetchWithReader.mockRejectedValueOnce(new Error("Failed to read: API error (422): No content"));

		const { fetchWithFallback } = await import("../extensions/readers/dispatch.js");
		await expect(
			fetchWithFallback(
				"https://example.com",
				["jina"],
				{},
				undefined,
				MINIMAL_CONFIG,
			),
		).rejects.toThrow(/All readers failed: jina/);

		expect(mockFetchWithReader).toHaveBeenCalledTimes(1);
	});
});

describe("thin-content gate", () => {
	const GATED_CONFIG: SearchConfig = { defaultBackend: "duckduckgo", backends: {}, minContentChars: 500 };
	const longEnough = (ch: string, n = 600) => ch.repeat(n);

	beforeEach(() => {
		mockFetchWithReader.mockClear();
	});

	it("falls through when the first reader returns shell-only output", async () => {
		mockFetchWithReader.mockResolvedValueOnce(makeResult("[Login](https://example.com/login)", "defuddle"));
		mockFetchWithReader.mockResolvedValueOnce(makeResult(longEnough("real article text. "), "jina"));

		const { fetchWithFallback } = await import("../extensions/readers/dispatch.js");
		const result = await fetchWithFallback(
			"https://example.com",
			["defuddle", "jina"],
			{},
			undefined,
			GATED_CONFIG,
		);

		expect(result.reader).toBe("jina");
		expect(result.content).toContain("real article text");
		expect(result.warning).toBeUndefined();
		expect(mockFetchWithReader).toHaveBeenCalledTimes(2);
	});

	it("returns the requested reader output with a warning when every reader is thin", async () => {
		// Longer second output must NOT win: envelope boilerplate outranking
		// real but short content is exactly what first-wins prevents.
		mockFetchWithReader.mockResolvedValueOnce(makeResult("ab", "defuddle"));
		mockFetchWithReader.mockResolvedValueOnce(makeResult("abcd plus padding", "jina"));

		const { fetchWithFallback } = await import("../extensions/readers/dispatch.js");
		const result = await fetchWithFallback(
			"https://example.com",
			["defuddle", "jina"],
			{},
			undefined,
			GATED_CONFIG,
		);

		expect(result.reader).toBe("defuddle");
		expect(result.content).toBe("ab");
		expect(result.warning).toMatch(/thin content/);
	});

	it("treats boundary length (exactly min) as acceptable", async () => {
		mockFetchWithReader.mockResolvedValueOnce(makeResult(longEnough("x", 500), "jina"));

		const { fetchWithFallback } = await import("../extensions/readers/dispatch.js");
		const result = await fetchWithFallback(
			"https://example.com",
			["jina"],
			{},
			undefined,
			GATED_CONFIG,
		);

		expect(result.reader).toBe("jina");
		expect(result.warning).toBeUndefined();
		expect(mockFetchWithReader).toHaveBeenCalledTimes(1);
	});

	it("still throws combined error when readers fail (not just thin)", async () => {
		mockFetchWithReader.mockRejectedValueOnce(new Error("Failed to read: API error (422): gone"));
		mockFetchWithReader.mockResolvedValueOnce(makeResult("tiny", "jina"));

		const { fetchWithFallback } = await import("../extensions/readers/dispatch.js");
		await expect(
			fetchWithFallback("https://example.com", ["defuddle", "jina"], {}, undefined, GATED_CONFIG),
		).rejects.toThrow(/All readers failed/);
	});

	it("uses 500 as the default gate when unconfigured", async () => {
		mockFetchWithReader.mockResolvedValueOnce(makeResult(longEnough("y", 499), "jina"));
		mockFetchWithReader.mockResolvedValueOnce(makeResult(longEnough("z", 600), "sofya"));

		const { fetchWithFallback } = await import("../extensions/readers/dispatch.js");
		const result = await fetchWithFallback(
			"https://example.com",
			["jina", "sofya"],
			{},
			undefined,
			{ defaultBackend: "duckduckgo", backends: {} },
		);

		expect(result.reader).toBe("sofya");
	});
});
