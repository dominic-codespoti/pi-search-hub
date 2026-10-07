/**
 * Tests for challenge-page detection — ported signatures from
 * agent-reach channels/web.py::_is_antibot_page.
 */
import { describe, it, expect } from "vitest";
import { isChallengeContent } from "./quality.js";

describe("isChallengeContent", () => {
	it("detects Jina captcha warning with challenge structure", () => {
		const body = `Title: Just a moment...\nWarning: this site is requiring captcha\n## Performing security verification\n${"x".repeat(500)}`;
		expect(isChallengeContent(body)).toBe(true);
	});

	it("detects Cloudflare attention-required block with ray id", () => {
		const body = `Title: Attention Required! | Cloudflare\nRay ID: abc123\n${"y".repeat(500)}`;
		expect(isChallengeContent(body)).toBe(true);
	});

	it("detects Cloudflare block with challenge-platform path", () => {
		const body = `Title: Attention Required! | Cloudflare\n/cdn-cgi/challenge-platform/foo`;
		expect(isChallengeContent(body)).toBe(true);
	});

	it("does not flag a genuine article that merely mentions Cloudflare", () => {
		const body = `We migrated our CDN to Cloudflare last year. Captcha solving is a research topic. ${"z".repeat(4500)}`;
		expect(isChallengeContent(body)).toBe(false);
	});

	it("ignores challenge-like text beyond the leading scan window", () => {
		const body = `${"a".repeat(5000)}Title: Just a moment... ## Performing security verification`;
		expect(isChallengeContent(body)).toBe(false);
	});

	it("returns false for empty content", () => {
		expect(isChallengeContent("")).toBe(false);
		expect(isChallengeContent("   ")).toBe(false);
	});
});
