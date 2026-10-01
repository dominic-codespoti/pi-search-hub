/**
 * Unit tests for the Anydoc reader (local file → Markdown) and the
 * attachment discovery scan. The native binding is mocked; conversion
 * quality was proven separately by live trial (native PDF converts,
 * scanned PDF rejects with needsOcr).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { findAttachments } from "./attachments.js";

const { toMarkdownBytesMock, formatFromExtensionMock } = vi.hoisted(() => ({
	toMarkdownBytesMock: vi.fn(),
	formatFromExtensionMock: vi.fn(),
}));

vi.mock("@firecrawl/anydoc", () => ({
	toMarkdownBytes: toMarkdownBytesMock,
	formatFromExtension: formatFromExtensionMock,
}));

import { fetchAnydoc } from "./anydoc.js";

function mockFileResponse(bytes: Uint8Array, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: () => null },
		arrayBuffer: async () => bytes.buffer,
		text: async () => "",
	} as unknown as Response;
}

describe("fetchAnydoc", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(global, "fetch");
		toMarkdownBytesMock.mockReset();
		formatFromExtensionMock.mockReset();
		formatFromExtensionMock.mockReturnValue("pdf");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("converts file bytes with a single fetch and titles from the filename", async () => {
		fetchSpy.mockResolvedValueOnce(mockFileResponse(new Uint8Array([1, 2, 3])));
		toMarkdownBytesMock.mockResolvedValueOnce("## Converted Doc");

		const result = await fetchAnydoc("https://example.com/files/report.pdf");

		expect(result.content).toBe("## Converted Doc");
		expect(result.title).toBe("report.pdf");
		expect(result.meta).toEqual({ title: "report.pdf" });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(toMarkdownBytesMock).toHaveBeenCalledTimes(1);
		expect(formatFromExtensionMock).toHaveBeenCalledWith("pdf");
	});

	it("maps needsOcr to a fallback-friendly error", async () => {
		fetchSpy.mockResolvedValueOnce(mockFileResponse(new Uint8Array([1])));
		toMarkdownBytesMock.mockRejectedValueOnce(Object.assign(new Error("scan"), { code: "needsOcr" }));

		await expect(fetchAnydoc("https://example.com/scan.pdf")).rejects.toThrow(/falling back/);
	});

	it("maps unsupported input to a fallback-friendly error", async () => {
		fetchSpy.mockResolvedValueOnce(mockFileResponse(new Uint8Array([1])));
		toMarkdownBytesMock.mockRejectedValueOnce(Object.assign(new Error("nope"), { code: "unsupported" }));

		await expect(fetchAnydoc("https://example.com/odd.xyz")).rejects.toThrow(/cannot convert/);
	});

	it("throws on empty conversion so the chain falls through", async () => {
		fetchSpy.mockResolvedValueOnce(mockFileResponse(new Uint8Array([1])));
		toMarkdownBytesMock.mockResolvedValueOnce("   \n ");

		await expect(fetchAnydoc("https://example.com/empty.pdf")).rejects.toThrow(/no content/);
	});

	it("refuses oversized files before buffering", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: { get: () => String(21 * 1024 * 1024) },
			arrayBuffer: async () => new ArrayBuffer(0),
			text: async () => "",
		} as unknown as Response);

		await expect(fetchAnydoc("https://example.com/huge.pdf")).rejects.toThrow(/too large/);
		expect(toMarkdownBytesMock).not.toHaveBeenCalled();
	});

	it("throws on transport errors", async () => {
		fetchSpy.mockResolvedValueOnce(mockFileResponse(new Uint8Array(), 404));

		await expect(fetchAnydoc("https://example.com/missing.pdf")).rejects.toThrow(/Failed to read/);
	});
});

describe("findAttachments", () => {
	const PAGE = "https://example.com/docs/index.html";

	it("finds file links, resolves relative URLs, keeps link text", async () => {
		const md = [
			"[Full report](files/report.pdf)",
			"[Budget](/assets/budget.xlsx?dl=1)",
			"[Article](https://example.com/other)",
			"[Image](img/photo.png)",
		].join("\n");

		expect(findAttachments(md, PAGE)).toEqual([
			{ url: "https://example.com/docs/files/report.pdf", text: "Full report" },
			{ url: "https://example.com/assets/budget.xlsx?dl=1", text: "Budget" },
		]);
	});

	it("dedupes, ignores non-attachment links and caps output", async () => {
		const md = ["[A](r.pdf)", "[A again](r.pdf)", "[B](x.html)", "[C](y.docx)"].join("\n");

		expect(findAttachments(md, PAGE)).toEqual([
			{ url: "https://example.com/docs/r.pdf", text: "A" },
			{ url: "https://example.com/docs/y.docx", text: "C" },
		]);
	});

	it("returns [] when nothing matches", async () => {
		expect(findAttachments("No links here.", PAGE)).toEqual([]);
		expect(findAttachments("[Anchors](#section)", PAGE)).toEqual([]);
	});
});
