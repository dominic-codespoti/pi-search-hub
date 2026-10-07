/**
 * Reader dispatch for web_read — fallback orchestration across multiple
 * content extraction backends (Jina, Sofya, Firecrawl, Exa, Exa MCP).
 *
 * The single-reader logic lives in single.ts; this module adds retry/fallback.
 */

import type { SearchConfig } from "../types.js";
import { fetchWithReader, readerLabel } from "./single.js";
import type { FetchParams, FetchResult } from "./single.js";
import { isChallengeContent } from "./quality.js";
import { isRetryableReaderError } from "./errors.js";

export type { FetchParams, FetchResult } from "./single.js";
export { fetchWithReader, readerLabel } from "./single.js";
/** Default fallback order for readers. */
export const DEFAULT_READER_FALLBACK = ["jina", "sofya", "firecrawl", "exa", "exa_mcp"];

/**
 * Determine whether a reader error should try the next reader.
 *
 * Only keyed-reader upstream auth (Sofya/Exa 401/403) is terminal.
 * Target denial/challenge, 422/5xx, network errors and timeouts retry.
 * Unknown 401/403 stays conservative (fatal) unless explicitly marked
 * as a target failure via ReaderError. Cancellation/unsafe-URL never retry.
 */
function isRetryableError(err: unknown): boolean {
	return isRetryableReaderError(err);
}

/**
 * Native source readers with their own completeness semantics — valid short
 * feeds/transcripts succeed without hitting the generic page thin-content gate.
 * (Challenge/empty rejection above still applies to every reader.)
 */
const NATIVE_READERS = new Set(["rss", "youtube"]);


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
		signal?.throwIfAborted();
		const candidate = readers[i];
		onAttempt?.(candidate, i, readers.length);

		try {
			const result = await fetchWithReader(url, candidate, params, signal, config);
			signal?.throwIfAborted();
			const trimmedLen = result.content.trim().length;
			// Empty output is a failure, not thin content — never a winner.
			if (trimmedLen === 0) {
				errors.push({ reader: candidate, error: "empty content" });
				hardError = true;
				if (i === readers.length - 1) {
					const summary = errors.map(e => `${e.reader}: ${e.error}`).join("; ");
					throw new Error(`All readers failed: ${summary}`);
				}
				continue;
			}
			// Challenge pages (HTTP 200 with CAPTCHA/Cloudflare body) are
			// retryable failures — never accepted or returned as thin winners.
			if (isChallengeContent(result.content)) {
				errors.push({ reader: candidate, error: `challenge page detected (${trimmedLen} chars)` });
				hardError = true;
				if (i === readers.length - 1) {
					const summary = errors.map(e => `${e.reader}: ${e.error}`).join("; ");
					throw new Error(`All readers failed: ${summary}`);
				}
				continue;
			}
			// Thin-content gate: shell-only output (e.g. unrendered JS pages)
			// falls through to the next reader instead of succeeding empty.
			// Native source readers (rss/youtube) carry their own completeness
			// semantics — valid short feeds/transcripts succeed as-is.
			if (minChars > 0 && !NATIVE_READERS.has(candidate) && trimmedLen < minChars) {
				errors.push({ reader: candidate, error: `thin content (${trimmedLen} chars < ${minChars})` });
				if (!first) first = result;
				continue;
			}
			// Success — return immediately
			return result;
		} catch (err) {
			signal?.throwIfAborted();
			const errorMsg = (err as Error).message;
			errors.push({ reader: candidate, error: errorMsg });
			hardError = true;

			// Keyed provider auth is fatal — do not fall through
			if (!isRetryableError(err)) {
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

	// Mixed failures plus thin results: stay loud and keep every detail so the
	// caller can see which readers errored and which were thin.
	const summary = errors.map((e) => `${e.reader}: ${e.error}`).join("; ");
	throw new Error(`All readers failed: ${summary || "no readers in fallback list"}`);
}
