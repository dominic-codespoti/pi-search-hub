/**
 * Tests for shared bounded HTTP helpers — streaming caps and redirect
 * re-validation. No real network; fetch is stubbed per test.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
	readBoundedText,
	readBoundedBytes,
	readErrorSnippet,
	fetchWithRedirectValidation,
} from "./http.js";

function streamResponse(text: string, headers: Record<string, string> = {}): Response {
	const data = new TextEncoder().encode(text);
	return new Response(new Blob([data as BlobPart]).stream(), { status: 200, headers });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("readBoundedText", () => {
	it("returns bodies under the cap", async () => {
		const res = streamResponse("hello world");
		await expect(readBoundedText(res, 1024, "https://example.com")).resolves.toBe("hello world");
	});

	it("enforces the cap even when Content-Length lies", async () => {
		const res = streamResponse("x".repeat(2000), { "content-length": "10" });
		await expect(readBoundedText(res, 1024, "https://example.com")).rejects.toThrow(
			/response too large/,
		);
	});
});

describe("readBoundedBytes", () => {
	it("caps binary bodies", async () => {
		const res = streamResponse("y".repeat(3000));
		await expect(readBoundedBytes(res, 1024, "https://example.com")).rejects.toThrow(
			/response too large/,
		);
	});
});

describe("readErrorSnippet", () => {
	it("caps huge error bodies", async () => {
		const res = streamResponse("e".repeat(100_000));
		const snippet = await readErrorSnippet(res);
		expect(snippet.length).toBeLessThanOrEqual(4 * 1024);
	});
});

describe("fetchWithRedirectValidation", () => {
	it("rejects unsafe initial URLs", async () => {
		await expect(
			fetchWithRedirectValidation("http://localhost:8080/", {}),
		).rejects.toThrow(/SSRF blocked/);
	});

	it("rejects redirects to private hosts", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url === "https://example.com/") {
					return new Response(null, {
						status: 302,
						headers: { location: "http://169.254.169.254/" },
					});
				}
				return new Response("unreachable", { status: 200 });
			}),
		);
		await expect(fetchWithRedirectValidation("https://example.com/", {})).rejects.toThrow(
			/SSRF blocked/,
		);
	});

	it("rejects too many redirects", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 302, headers: { location: "/loop" } })),
		);
		await expect(
			fetchWithRedirectValidation("https://example.com/start", {}, 2),
		).rejects.toThrow(/too many redirects/);
	});

	it("follows a relative redirect once", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				calls.push(url);
				if (url === "https://example.com/start") {
					return new Response(null, { status: 302, headers: { location: "/final" } });
				}
				return new Response("ok", { status: 200 });
			}),
		);
		const { finalUrl, redirects } = await fetchWithRedirectValidation(
			"https://example.com/start",
			{},
		);
		expect(finalUrl).toBe("https://example.com/final");
		expect(redirects).toBe(1);
		expect(calls).toEqual(["https://example.com/start", "https://example.com/final"]);
	});
});
