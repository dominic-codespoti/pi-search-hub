/**
 * Defuddle reader — keyless, fully local HTML → Markdown extraction.
 *
 * Opt-in second view for web_read (`reader: "defuddle"`). Jina remains the
 * default; Defuddle is for when Jina output looks poor (boilerplate-heavy
 * articles, unfenced code examples). No API key, no network beyond the single
 * page fetch, no JavaScript execution — JS-rendered pages return shell only
 * and should fall back to a rendering reader (Jina).
 *
 * Options below are the validated per-source policy from the six-page
 * offline comparison (Defuddle 0.19.4 + linkedom 0.18.12):
 * - keep reference-link and screen-reader text (Sphinx `reference` links and
 *   Wikipedia `.sfrac` fraction slashes are content, not clutter);
 * - disable HTML standardization on wikipedia.org only (preserves caption
 *   `<i>`/`<sup>` variables; applied narrowly because it breaks fenced-code
 *   recognition on documentation pages).
 */

import { parseHTML } from "linkedom";
import { Defuddle } from "defuddle/node";
import { timeoutSignal, sanitizeError } from "../utils.js";
import { readBoundedText, readErrorSnippet, fetchWithRedirectValidation } from "../http.js";
import { targetBlockedError } from "./errors.js";
/** Cap on fetched HTML, in bytes, mirroring the Jina reader path. */
const DEFUDDLE_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

/** Hosts where HTML standardization is disabled (caption math fidelity). */
function defuddleOptions(url: string): Record<string, unknown> {
	const base = {
		markdown: true,
		// Strictly local: never call third-party extractor APIs when local
		// content is missing — return what the HTML holds or fail.
		useAsync: false,
		// Sphinx `class="reference internal"` cross-reference links and
		// screen-reader fraction slashes are content, not ad clutter.
		removeExactSelectors: false,
		removePartialSelectors: false,
	};
	try {
		if (new URL(url).hostname.endsWith("wikipedia.org")) {
			return { ...base, standardize: false };
		}
	} catch {
		// Invalid URL — caller validates; fall through with base options.
	}
	return base;
}

/**
 * Fetch a URL and extract clean Markdown locally via Defuddle.
 * Throws on transport error or empty extraction so the reader fallback
 * chain can try the next reader (usually Jina).
 */
export async function fetchDefuddle(
	url: string,
	signal?: AbortSignal,
): Promise<{ title: string; url: string; content: string; meta?: { author?: string; published?: string; description?: string } }> {
	const { response } = await fetchWithRedirectValidation(url, {
		signal: timeoutSignal(signal),
		headers: {
			Accept: "text/html",
			"Accept-Language": "en",
			"User-Agent": "pi-search-hub/reader (local Defuddle extraction)",
		},
	});

	if (!response.ok) {
		const snippet = await readErrorSnippet(response);
		const msg = `Failed to read ${url}: ${sanitizeError(response.status, snippet)}`;
		// Direct target fetch: 401/403 is target denial, retryable.
		if (response.status === 401 || response.status === 403) throw targetBlockedError("defuddle", response.status, msg);
		throw new Error(msg);
	}

	const contentLength = parseInt(response.headers.get("content-length") ?? "", 10);
	if (Number.isFinite(contentLength) && contentLength > DEFUDDLE_MAX_BYTES) {
		throw new Error(`Failed to read ${url}: response too large (${contentLength} bytes, limit ${DEFUDDLE_MAX_BYTES})`);
	}

	const html = await readBoundedText(response, DEFUDDLE_MAX_BYTES, url);
	if (signal?.aborted) {
		throw new Error(`Defuddle read cancelled for ${url}`);
	}

	const { document } = parseHTML(html);
	const result = await Defuddle(document, url, defuddleOptions(url));
	const content = result.content ?? "";
	if (content.trim().length === 0) {
		throw new Error(`Defuddle returned no content for ${url}`);
	}

	const meta: { author?: string; published?: string; description?: string } = {};
	for (const key of ["author", "published", "description"] as const) {
		const value = result[key]?.trim();
		if (value) meta[key] = value;
	}
	return {
		title: result.title || "",
		url,
		content,
		// Native document metadata; title travels separately for Jina-envelope parity.
		meta: Object.keys(meta).length > 0 ? meta : undefined,
	};
}
