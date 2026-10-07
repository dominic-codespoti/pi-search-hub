/**
 * Tests for the native source registry — explicit adapters, exact
 * host/subdomain matching (no lookalikes or userinfo disguises).
 */
import { describe, it, expect } from "vitest";
import { getSource, getAllSources } from "./registry.js";

describe("source registry", () => {
	it("exposes the initial sources", () => {
		const ids = getAllSources().map((s) => s.id).sort();
		expect(ids).toEqual(["duckduckgo", "rss", "youtube"]);
	});

	it("returns undefined for unknown ids", () => {
		expect(getSource("twitter")).toBeUndefined();
	});

	it("matches YouTube hosts exactly or as subdomains", () => {
		const yt = getSource("youtube")!;
		expect(yt.matchesUrl?.("https://www.youtube.com/watch?v=abc")).toBe(true);
		expect(yt.matchesUrl?.("https://youtu.be/abc")).toBe(true);
		expect(yt.matchesUrl?.("https://m.youtube.com/watch?v=abc")).toBe(true);
	});

	it("rejects lookalikes and userinfo disguises", () => {
		const yt = getSource("youtube")!;
		expect(yt.matchesUrl?.("https://youtube.com.evil.test/watch")).toBe(false);
		expect(yt.matchesUrl?.("https://youtube.com@evil.test/")).toBe(false);
		expect(yt.matchesUrl?.("https://example.com/")).toBe(false);
		expect(yt.matchesUrl?.("not a url")).toBe(false);
	});

	it("every source has a local probe", () => {
		for (const s of getAllSources()) {
			expect(typeof s.probe).toBe("function");
		}
	});
});
