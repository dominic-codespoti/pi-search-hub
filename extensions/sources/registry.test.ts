/**
 * Tests for the native source registry — explicit adapters only.
 * There is no automatic URL routing: readers are chosen explicitly via
 * web_read's reader param (URL validation lives in each reader).
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

	it("exposes no URL routing — readers are explicit-only", () => {
		for (const s of getAllSources()) {
			expect("matchesUrl" in s).toBe(false);
		}
	});

	it("every source has a local probe", () => {
		for (const s of getAllSources()) {
			expect(typeof s.probe).toBe("function");
		}
	});
});
