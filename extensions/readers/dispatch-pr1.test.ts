/**
 * PR1 fallback additions — challenge/empty rejection, abort handling, and
 * provider-auth vs target-denial classification. Mocks fetchWithReader so
 * dispatch logic is tested in isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SearchConfig } from "../types.js";
import type { FetchResult } from "./single.js";
import { targetBlockedError, providerAuthError } from "./errors.js";

const mockFetchWithReader = vi.fn<(...args: unknown[]) => Promise<FetchResult>>();

vi.mock("./single.js", () => ({
	fetchWithReader: mockFetchWithReader,
	readerLabel: (r: string) => r,
}));

const CONFIG: SearchConfig = { defaultBackend: "duckduckgo", backends: {}, minContentChars: 0 };
const ok = (content: string, reader: string): FetchResult => ({ content, reader });

describe("fetchWithFallback PR1", () => {
	beforeEach(() => {
		mockFetchWithReader.mockClear();
	});

	it("rejects challenge pages and tries the next reader", async () => {
		mockFetchWithReader
			.mockResolvedValueOnce(
				ok(
					"Title: Just a moment...\nWarning: requiring captcha\n## Performing security verification\n" +
						"x".repeat(600),
					"jina",
				),
			)
			.mockResolvedValueOnce(ok("real article ".repeat(60), "sofya"));
		const { fetchWithFallback } = await import("./dispatch.js");
		const result = await fetchWithFallback(
			"https://example.com",
			["jina", "sofya"],
			{},
			undefined,
			CONFIG,
		);
		expect(result.reader).toBe("sofya");
		expect(mockFetchWithReader).toHaveBeenCalledTimes(2);
	});

	it("fails when every reader returns a challenge page", async () => {
		const challenge = (reader: string) =>
			ok(
				"Title: Attention Required! | Cloudflare\nRay ID: 1\n" + "y".repeat(600),
				reader,
			);
		mockFetchWithReader
			.mockResolvedValueOnce(challenge("jina"))
			.mockResolvedValueOnce(challenge("sofya"));
		const { fetchWithFallback } = await import("./dispatch.js");
		await expect(
			fetchWithFallback("https://example.com", ["jina", "sofya"], {}, undefined, CONFIG),
		).rejects.toThrow(/challenge page detected/);
	});

	it("treats empty content as failure, not a thin winner", async () => {
		mockFetchWithReader
			.mockResolvedValueOnce(ok("   ", "jina"))
			.mockResolvedValueOnce(ok("real content ".repeat(60), "sofya"));
		const { fetchWithFallback } = await import("./dispatch.js");
		const result = await fetchWithFallback(
			"https://example.com",
			["jina", "sofya"],
			{},
			undefined,
			CONFIG,
		);
		expect(result.reader).toBe("sofya");
	});

	it("retries target-denial but stops on provider auth", async () => {
		mockFetchWithReader.mockRejectedValueOnce(
			targetBlockedError("jina", 403, "Failed to read https://example.com: API error (403)"),
		);
		mockFetchWithReader.mockResolvedValueOnce(ok("recovered ".repeat(60), "sofya"));
		const { fetchWithFallback } = await import("./dispatch.js");
		const retried = await fetchWithFallback(
			"https://example.com",
			["jina", "sofya"],
			{},
			undefined,
			CONFIG,
		);
		expect(retried.reader).toBe("sofya");

		mockFetchWithReader.mockClear();
		mockFetchWithReader.mockRejectedValueOnce(
			providerAuthError("sofya", 401, "API error (401): Unauthorized"),
		);
		await expect(
			fetchWithFallback("https://example.com", ["sofya", "firecrawl"], {}, undefined, CONFIG),
		).rejects.toThrow(/401/);
		expect(mockFetchWithReader).toHaveBeenCalledTimes(1);
	});

	it("mixed thin results plus a hard error report every detail", async () => {
		const gated: SearchConfig = { defaultBackend: "duckduckgo", backends: {}, minContentChars: 500 };
		mockFetchWithReader
			.mockRejectedValueOnce(new Error("Sofya reader selected but no API key configured"))
			.mockResolvedValueOnce({ content: "short", reader: "jina" });
		const { fetchWithFallback } = await import("./dispatch.js");
		await expect(
			fetchWithFallback("https://example.com", ["sofya", "jina"], {}, undefined, gated),
		).rejects.toThrow(/sofya: Sofya reader selected but no API key.*jina: thin content/);
	});

	it("does not continue after abort", async () => {
		const controller = new AbortController();
		controller.abort();
		const { fetchWithFallback } = await import("./dispatch.js");
		await expect(
			fetchWithFallback(
				"https://example.com",
				["jina", "sofya"],
				{},
				controller.signal,
				CONFIG,
			),
		).rejects.toThrow();
		expect(mockFetchWithReader).not.toHaveBeenCalled();
	});

	it("native rss readers bypass the generic thin-content gate", async () => {
		// 500-char gate config, but a short valid feed succeeds as rss.
		const gated: SearchConfig = { defaultBackend: "duckduckgo", backends: {}, minContentChars: 500 };
		mockFetchWithReader.mockResolvedValueOnce({ content: "# Tiny feed\n\nFeed is empty (0 entries).", reader: "rss" });
		const { fetchWithFallback } = await import("./dispatch.js");
		const result = await fetchWithFallback("https://example.com/feed.xml", ["rss", "jina"], {}, undefined, gated);
		expect(result.reader).toBe("rss");
		expect(result.warning).toBeUndefined();
		expect(mockFetchWithReader).toHaveBeenCalledTimes(1);
	});
});
