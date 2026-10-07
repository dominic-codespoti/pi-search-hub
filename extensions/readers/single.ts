/**
 * Single-reader fetch — one reader, no fallback.
 * Extracted so fetchWithFallback can import it and tests can mock it.
 */

import type { SearchConfig } from "../types.js";
import { timeoutSignal, sanitizeError, MISSING_KEY_HELP } from "../utils.js";
import { resolveBackendKey } from "../credentials.js";
import { fetchSofya } from "../backends/sofya.js";
import { fetchFirecrawl } from "../backends/firecrawl.js";
import { fetchExaContents } from "../backends/exa.js";
import { fetchExaMCP } from "../backends/exa-mcp.js";
import { fetchDefuddle } from "./defuddle.js";
import { fetchAnydoc } from "./anydoc.js";
import { fetchRssFeed } from "../sources/rss.js";
import { fetchYoutubeTranscript } from "../sources/youtube.js";
import { readBoundedText, readErrorSnippet } from "../http.js";
import { providerAuthError, targetBlockedError } from "./errors.js";
/** Cap on a single web_read response body, in bytes, to bound memory use on heavy pages. */
const READ_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

export interface FetchParams {
	fresh?: boolean;
	keywords?: string[];
	mode?: string;
	objective?: string;
	/** Preferred caption language for reader youtube (BCP-47, default en). Ignored by other readers. */
	language?: string;
}

/** Optional document metadata a reader extracted natively. Absent fields are omitted, never fabricated. */
export interface ReaderMeta {
	title?: string;
	author?: string;
	published?: string;
	description?: string;
}

export interface FetchResult {
	content: string;
	reader: string;
	warning?: string;
	meta?: ReaderMeta;
}

/** Drop empty metadata fields so absent stays absent. */
export function cleanMeta(meta: ReaderMeta): ReaderMeta | undefined {
	const out: ReaderMeta = {};
	for (const key of ["title", "author", "published", "description"] as const) {
		const value = meta[key]?.trim();
		if (value) out[key] = value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse Jina Reader's response envelope (Title: / Published Time: headers
 * preceding the Markdown body) into metadata. Only the leading lines are
 * inspected so body text can never be mistaken for envelope headers.
 */
export function parseJinaMeta(body: string): ReaderMeta | undefined {
	const head = body.split("\n", 6).join("\n");
	const title = head.match(/^Title:\s*(.+)$/m)?.[1];
	const published = head.match(/^Published Time:\s*(.+)$/m)?.[1];
	return cleanMeta({ title, published });
}

/** Human-readable label for each reader. */
export function readerLabel(reader: string): string {
	switch (reader) {
		case "defuddle": return "Defuddle";
		case "anydoc": return "Anydoc";
		case "rss": return "RSS";
		case "youtube": return "YouTube";
		case "sofya": return "Sofya";
		case "firecrawl": return "Firecrawl";
		case "exa": return "Exa";
		case "exa_mcp": return "Exa MCP";
		default: return "Jina";
	}
}

/**
 * Fetch a URL using the specified reader backend.
 *
 * @param url    - The URL to fetch (already validated for SSRF).
 * @param reader - Reader backend name ("jina", "defuddle", "anydoc", "rss", "youtube", "sofya", "firecrawl", "exa", "exa_mcp").
 * @param params - Additional parameters (fresh, keywords, mode, objective, language).
 * @param signal - Optional abort signal.
 * @param config - Search config for credential resolution.
 * @returns The fetched content and the reader that served it.
 */
export async function fetchWithReader(
	url: string,
	reader: string,
	params: FetchParams,
	signal: AbortSignal | undefined,
	config: SearchConfig,
): Promise<FetchResult> {
	switch (reader) {
		case "sofya": {
			const sofyaKey = resolveBackendKey("sofya", config);
			if (!sofyaKey) {
				throw new Error(`Sofya reader selected but no API key configured. ${MISSING_KEY_HELP}`);
			}
			try {
				const result = await fetchSofya(url, sofyaKey, signal);
				return { content: result.content, reader: "sofya", meta: cleanMeta({ title: result.title }) };
			} catch (err) {
				const msg = (err as Error).message;
				const m = msg.match(/\b(401|403)\b/);
				if (m) throw providerAuthError("sofya", parseInt(m[1], 10), msg);
				throw err;
			}
		}

		case "firecrawl": {
			const firecrawlKey = resolveBackendKey("firecrawl", config);
			const result = await fetchFirecrawl(url, firecrawlKey, signal);
			return { content: result.content, reader: "firecrawl", meta: cleanMeta({ title: result.title }) };
		}

		case "exa": {
			const exaKey = resolveBackendKey("exa", config);
			if (!exaKey) {
				throw new Error(`Exa reader selected but no API key configured. ${MISSING_KEY_HELP}`);
			}
			try {
				const result = await fetchExaContents(url, exaKey, signal);
				return { content: result.content, reader: "exa", warning: result.warning, meta: cleanMeta({ title: result.title }) };
			} catch (err) {
				const msg = (err as Error).message;
				const m = msg.match(/\b(401|403)\b/);
				if (m) throw providerAuthError("exa", parseInt(m[1], 10), msg);
				throw err;
			}
		}

		case "exa_mcp": {
			const result = await fetchExaMCP(url, signal);
			return { content: result.content, reader: "exa_mcp", meta: cleanMeta({ title: result.title }) };
		}

		case "defuddle": {
			// Local, keyless HTML → Markdown extraction. Opt-in second view;
			// Jina remains the default reader. Throws on empty extraction so
			// the fallback chain can try the next reader.
			const result = await fetchDefuddle(url, signal);
			return { content: result.content, reader: "defuddle", meta: cleanMeta({ title: result.title, ...result.meta }) };
		}

		case "anydoc": {
			// Local, keyless file → Markdown conversion. Opt-in for file URLs;
			// needsOcr/unsupported input throws so the chain falls back (cloud OCR).
			const result = await fetchAnydoc(url, signal);
			return { content: result.content, reader: "anydoc", meta: cleanMeta({ title: result.title, ...result.meta }) };
		}

		case "rss": {
			// Local, keyless feed → Markdown conversion. Explicit source reader;
			// non-feed bodies throw so the chain can try the next reader.
			const result = await fetchRssFeed(url, signal);
			return { content: result.content, reader: "rss", meta: cleanMeta({ title: result.title, ...result.meta }) };
		}

		case "youtube": {
			// Local transcript via yt-dlp (optional system dependency). Failures
			// are terminal (no generic fallback) so transcript requests can
			// never silently succeed with watch-page text.
			const result = await fetchYoutubeTranscript(url, { language: params.language, signal });
			return { content: result.content, reader: "youtube", meta: cleanMeta({ title: result.title, ...result.meta }) };
		}
		default: {
			// Jina Reader: free, supports keywords / mode / objective hints.
			const readerUrl = new URL("https://r.jina.ai/" + url);

			const headers: Record<string, string> = {
				"Accept": "text/plain",
			};

			// Optional Jina API key for higher rate limits (fallback to no-auth)
			const jinaKey = resolveBackendKey("jina", config);
			if (jinaKey) {
				headers["Authorization"] = `Bearer ${jinaKey}`;
			}

			if (params.fresh) {
				headers["x-no-cache"] = "true";
			}
			if (params.keywords && params.keywords.length > 0) {
				headers["x-keywords"] = params.keywords.join(", ");
			}
			if (params.mode) {
				headers["x-respond-with"] = params.mode === "rush" ? "text" : "markdown";
			}
			if (params.objective) {
				headers["x-target-selector"] = params.objective;
			}

			const response = await fetch(readerUrl.toString(), {
				signal: timeoutSignal(signal),
				headers,
			});

			if (!response.ok) {
				const snippet = await readErrorSnippet(response);
				const msg = `Failed to read ${url}: ${sanitizeError(response.status, snippet)}`;
				// Jina is not a keyed reader: 401/403 here is target denial,
				// retryable via the next reader — not terminal provider auth.
				if (response.status === 401 || response.status === 403) throw targetBlockedError("jina", response.status, msg);
				throw new Error(msg);
			}

			// Streaming size guard — enforced while reading, not just headers.
			// Keep the 2 MiB ceiling; Reach uses 5 MiB for the same shape.
			const contentLength = parseInt(response.headers.get("content-length") ?? "", 10);
			if (Number.isFinite(contentLength) && contentLength > READ_MAX_BYTES) {
				throw new Error(`Failed to read ${url}: response too large (${contentLength} bytes, limit ${READ_MAX_BYTES})`);
			}
			const content = await readBoundedText(response, READ_MAX_BYTES, url);
			return { content, reader: "jina", meta: parseJinaMeta(content) };
		}
	}
}
