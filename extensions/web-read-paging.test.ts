/**
 * Execute-level tests for web_read paging (offset/limit), metadata and
 * content-count details. fetchWithFallback is mocked; slicing, validation
 * and details assembly are exercised through the real tool.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", async () => {
	const { Type } = await import("typebox");
	return { StringEnum: (values: string[]) => Type.Union(values.map(value => Type.Literal(value))) };
});

const { fetchWithFallbackMock } = vi.hoisted(() => ({ fetchWithFallbackMock: vi.fn() }));
vi.mock("./readers/dispatch.js", async importOriginal => {
	const mod = await importOriginal<typeof import("./readers/dispatch.js")>();
	return { ...mod, fetchWithFallback: fetchWithFallbackMock };
});

import searchHub from "./search-hub.js";
import { refreshConfig } from "./config.js";

describe("web_read paging and details", () => {
	let root: string;
	let tool: any;
	let ctx: any;
	let signal: AbortSignal;

	// 25,000 chars over 500 lines — deterministic fixture.
	const line = "The quick brown fox jumps over the lazy dog.0123456789 ";
	const FULL = line.repeat(500);
	const LINES = FULL.split("\n").length;

	function serve(content: string, extra: Record<string, unknown> = {}) {
		fetchWithFallbackMock.mockResolvedValueOnce({ content, reader: "jina", ...extra });
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-search-read-"));
		mkdirSync(join(root, "extensions"));
		writeFileSync(join(root, "extensions", "search.json"), JSON.stringify({ defaultBackend: "auto" }));
		vi.stubEnv("PI_CODING_AGENT_DIR", root);
		signal = new AbortController().signal;
		ctx = { cwd: root, hasUI: false, ui: { setStatus: vi.fn(), notify: vi.fn() } };
		fetchWithFallbackMock.mockReset();
		searchHub({
			registerTool: (registered: any) => { if (registered.name === "web_read") tool = registered; },
			registerCommand: vi.fn(),
			on: vi.fn(),
		} as any);
		refreshConfig(root, true);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	const read = (params: Record<string, unknown>) =>
		tool.execute("call", { url: "https://example.com/page", ...params }, signal, undefined, ctx);

	it("defaults to the historic first-10000-chars output", async () => {
		serve(FULL);
		const result = await read({});

		expect(result.content[0].text).toBe(FULL.slice(0, 10000));
		expect(result.details).toMatchObject({
			url: "https://example.com/page",
			reader: "jina",
			length: FULL.length,
			truncated: true,
			offset: 0,
			limit: 10000,
			nextOffset: 10000,
		});
		expect(result.details.counts).toEqual({
			chars: FULL.length,
			words: FULL.trim().split(/\s+/).length,
			lines: LINES,
		});
	});

	it("walks pages via nextOffset to a clean terminal state", async () => {
		serve(FULL);
		const first = await read({ limit: 20000 });
		expect(first.details.nextOffset).toBe(20000);

		serve(FULL);
		const second = await read({ offset: first.details.nextOffset, limit: 20000 });
		expect(second.content[0].text).toBe(FULL.slice(20000));
		expect(second.details.truncated).toBe(false);
		expect(second.details.nextOffset).toBeNull();
	});

	it("returns empty text with null nextOffset past the end", async () => {
		serve(FULL);
		const result = await read({ offset: FULL.length + 100 });

		expect(result.content[0].text).toBe("");
		expect(result.details.nextOffset).toBeNull();
		expect(result.details.truncated).toBe(false);
	});

	it("rejects negative offset and zero limit", async () => {
		serve(FULL);
		await expect(read({ offset: -5 })).rejects.toThrow(/Invalid offset/);
		await expect(read({ limit: 0 })).rejects.toThrow(/Invalid limit/);
		expect(fetchWithFallbackMock).not.toHaveBeenCalled();
	});

	it("passes reader meta through and notifies warnings", async () => {
		const meta = { title: "Some Article", author: "A. Uthor", published: "2026-09-01" };
		serve(FULL.slice(0, 100), { reader: "defuddle", meta, warning: "thin fallback" });
		const result = await read({});

		expect(result.details.meta).toEqual(meta);
		expect(result.details.reader).toBe("defuddle");
		expect(ctx.ui.notify).toHaveBeenCalledWith("thin fallback", "warn");
	});

	it("omits meta when the reader provides none", async () => {
		serve("short body");
		const result = await read({});

		expect(result.details.meta).toBeUndefined();
		expect(result.details.counts.words).toBe(2);
	});
});
