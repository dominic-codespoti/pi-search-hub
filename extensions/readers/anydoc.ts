/**
 * Anydoc reader — keyless, fully local file → Markdown conversion.
 *
 * Opt-in second view for web_read (`reader: "anydoc"`) aimed at file URLs
 * (PDF, Office, EPUB, CSV, RTF). Native digital documents convert in-process
 * in milliseconds; scanned/image-only PDFs hard-fail with `needsOcr` (anydoc
 * does no OCR) and fall through to the next reader (usually Jina cloud).
 *
 * Uses the @firecrawl/anydoc Node binding (pure Rust, no models, no system
 * deps, arm64 prebuilt). Format is sniffed from content, URL extension second.
 */

import { toMarkdownBytes, formatFromExtension } from "@firecrawl/anydoc";
import { timeoutSignal, sanitizeError } from "../utils.js";
import type { ReaderMeta } from "./single.js";

/** Cap on a single fetched file — attachments run larger than articles. */
const ANYDOC_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

/** Basename of the URL path, for a human-readable title. */
function fileTitle(url: string): string {
	try {
		const path = new URL(url).pathname;
		const base = decodeURIComponent(path.substring(path.lastIndexOf("/") + 1));
		return base || url;
	} catch {
		return url;
	}
}

function extensionHint(url: string): string | undefined {
	try {
		const path = new URL(url).pathname.toLowerCase();
		const dot = path.lastIndexOf(".");
		if (dot < 0) return undefined;
		return path.substring(dot + 1);
	} catch {
		return undefined;
	}
}

/**
 * Fetch a file URL and convert it to Markdown locally via Anydoc.
 * Throws on transport error, unsupported/encrypted/OCR-needing input, or
 * empty conversion so the reader fallback chain can try the next reader.
 */
export async function fetchAnydoc(
	url: string,
	signal?: AbortSignal,
): Promise<{ title: string; url: string; content: string; meta?: ReaderMeta }> {
	const response = await fetch(url, {
		signal: timeoutSignal(signal),
		headers: {
			Accept: "*/*",
			"User-Agent": "pi-search-hub/reader (local Anydoc extraction)",
		},
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Failed to read ${url}: ${sanitizeError(response.status, text)}`);
	}

	const contentLength = parseInt(response.headers.get("content-length") ?? "", 10);
	if (Number.isFinite(contentLength) && contentLength > ANYDOC_MAX_BYTES) {
		throw new Error(`Failed to read ${url}: response too large (${contentLength} bytes, limit ${ANYDOC_MAX_BYTES})`);
	}

	const buffer = new Uint8Array(await response.arrayBuffer());
	if (buffer.length > ANYDOC_MAX_BYTES) {
		throw new Error(`Failed to read ${url}: response too large (${buffer.length} bytes, limit ${ANYDOC_MAX_BYTES})`);
	}
	if (signal?.aborted) {
		throw new Error(`Anydoc read cancelled for ${url}`);
	}

	const ext = extensionHint(url);
	let markdown: string;
	try {
		markdown = await toMarkdownBytes(buffer, (ext && formatFromExtension(ext)) || undefined);
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code === "needsOcr") {
			throw new Error(`Anydoc cannot OCR image-only pages in ${url} — falling back to cloud reader`);
		}
		throw new Error(`Anydoc cannot convert ${url} (${code || (err as Error).message})`);
	}

	if (markdown.trim().length === 0) {
		throw new Error(`Anydoc returned no content for ${url}`);
	}

	const title = fileTitle(url);
	return { title, url, content: markdown, meta: { title } };
}
