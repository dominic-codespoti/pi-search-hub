/**
 * Reader dispatch for web_read — fallback orchestration across multiple
 * content extraction backends (Jina, Sofya, Firecrawl, Exa, Exa MCP).
 *
 * The single-reader logic lives in single.ts; this module adds retry/fallback.
 */

import type { SearchConfig } from "../types.js";
import { fetchWithReader, readerLabel } from "./single.js";
import type { FetchParams, FetchResult } from "./single.js";

export type { FetchParams, FetchResult } from "./single.js";
export { fetchWithReader, readerLabel } from "./single.js";

/** Default fallback order for readers. */
export const DEFAULT_READER_FALLBACK = ["jina", "sofya", "firecrawl", "exa", "exa_mcp"];

/**
 * Determine whether a reader error is retryable (transient) or fatal (auth).
 *
 * Retryable: 422, 5xx, network errors, timeouts, "no content" messages.
 * Fatal: 401, 403 — configuration problems, not transient.
 */
function isRetryableError(err: Error): boolean {
	const msg = err.message;
	// Auth errors — do NOT retry
	if (/\b(401|403)\b/.test(msg) || /unauthorized|forbidden/i.test(msg)) {
		return false;
	}
	// Everything else is retryable
	return true;
}

/**
 * Try readers in fallback order until one succeeds.
 *
 * @param url       - The URL to fetch (already validated for SSRF).
 * @param readers   - Ordered list of reader backends to try.
 * @param params    - Additional parameters (fresh, keywords, mode, objective).
 * @param signal    - Optional abort signal.
 * @param config    - Search config for credential resolution.
 * @param onAttempt - Optional callback fired before each attempt (for status updates).
 * @returns The fetched content and the reader that served it.
 */
export async function fetchWithFallback(
	url: string,
	readers: string[],
	params: FetchParams,
	signal: AbortSignal | undefined,
	config: SearchConfig,
	onAttempt?: (reader: string, index: number, total: number) => void,
): Promise<FetchResult> {
	const errors: Array<{ reader: string; error: string }> = [];
	const minChars = config.minContentChars ?? 500;
	let first: FetchResult | null = null;
	let hardError = false;

	for (let i = 0; i < readers.length; i++) {
		const candidate = readers[i];
		onAttempt?.(candidate, i, readers.length);

		try {
			const result = await fetchWithReader(url, candidate, params, signal, config);
			// Thin-content gate: shell-only output (e.g. unrendered JS pages)
			// falls through to the next reader instead of succeeding empty.
			if (minChars > 0 && result.content.trim().length < minChars) {
				errors.push({ reader: candidate, error: `thin content (${result.content.trim().length} chars < ${minChars})` });
				if (!first) first = result;
				continue;
			}
			// Success — return immediately
			return result;
		} catch (err) {
			const errorMsg = (err as Error).message;
			errors.push({ reader: candidate, error: errorMsg });
			hardError = true;

			// Auth errors are fatal — do not fall through
			if (!isRetryableError(err as Error)) {
				throw err;
			}

			// Last reader failed — throw combined error
			if (i === readers.length - 1) {
				const summary = errors
					.map(e => `${e.reader}: ${e.error}`)
					.join("; ");
				throw new Error(`All readers failed: ${summary}`);
			}
		}
	}

	// Every reader was thin but none errored — return the requested (first)
	// reader's output with a warning rather than failing a genuinely short
	// page. First-wins beats longest-wins: envelope boilerplate must not
	// outrank real but short content. Any hard error falls through to the
	// combined throw below so failures stay visible.
	if (first && !hardError) {
		return {
			...first,
			warning: `All readers returned thin content (<${minChars} chars); showing ${first.reader} output.`,
		};
	}

	// Should not reach here, but satisfy TS
	throw new Error("All readers failed: no readers in fallback list");
}
