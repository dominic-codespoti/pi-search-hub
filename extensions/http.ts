/**
 * Shared bounded HTTP helpers for direct-fetch readers.
 *
 * - Enforces real streaming byte caps (not just Content-Length headers).
 * - Caps error-body reads so a huge 500 page cannot OOM the extension.
 * - Validates every redirect hop with the existing SSRF guard.
 *
 * Remote provider fetches (Jina/Sofya/Firecrawl/Exa) keep their own
 * transports — this module is for fetches we perform ourselves
 * (Defuddle/Anydoc/RSS/captions). It does not control a remote provider's
 * internal fetching and does not sandbox subprocesses.
 */

import { validateUrl } from "./utils.js";

export const MAX_REDIRECTS = 3;
const ERROR_SNIPPET_BYTES = 4 * 1024;

function tooLargeError(url: string, bytes: number, limit: number): Error {
	return new Error(`Failed to read ${url}: response too large (${bytes} bytes, limit ${limit})`);
}

/** Read a small error-body snippet (never the full body) for diagnostics. */
export async function readErrorSnippet(response: Response): Promise<string> {
	try {
		if (!response.body) {
			const text = await response.text().catch(() => "");
			return text.slice(0, ERROR_SNIPPET_BYTES);
		}
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) {
					const take = Math.min(value.length, ERROR_SNIPPET_BYTES - total);
					chunks.push(value.slice(0, take));
					total += take;
					if (total >= ERROR_SNIPPET_BYTES) {
						try {
							await reader.cancel();
						} catch {
							// ignore
						}
						break;
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
		const merged = new Uint8Array(total);
		let off = 0;
		for (const c of chunks) {
			merged.set(c, off);
			off += c.length;
		}
		return new TextDecoder().decode(merged);
	} catch {
		return "";
	}
}

/** Stream a text body with a hard byte cap, regardless of Content-Length. */
export async function readBoundedText(
	response: Response,
	maxBytes: number,
	urlForMessage: string,
): Promise<string> {
	if (!response.body) {
		const text = await response.text();
		if (new TextEncoder().encode(text).length > maxBytes) {
			throw tooLargeError(urlForMessage, new TextEncoder().encode(text).length, maxBytes);
		}
		return text;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value && value.length > 0) {
				total += value.length;
				if (total > maxBytes) {
					try {
						await reader.cancel();
					} catch {
						// ignore
					}
					throw tooLargeError(urlForMessage, total, maxBytes);
				}
				chunks.push(value);
			}
		}
	} finally {
		reader.releaseLock();
	}
	const merged = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		merged.set(c, off);
		off += c.length;
	}
	return new TextDecoder().decode(merged);
}

/** Stream a binary body with a hard byte cap. */
export async function readBoundedBytes(
	response: Response,
	maxBytes: number,
	urlForMessage: string,
): Promise<Uint8Array> {
	if (!response.body) {
		const buf = new Uint8Array(await response.arrayBuffer());
		if (buf.length > maxBytes) throw tooLargeError(urlForMessage, buf.length, maxBytes);
		return buf;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value && value.length > 0) {
				total += value.length;
				if (total > maxBytes) {
					try {
						await reader.cancel();
					} catch {
						// ignore
					}
					throw tooLargeError(urlForMessage, total, maxBytes);
				}
				chunks.push(value);
			}
		}
	} finally {
		reader.releaseLock();
	}
	const merged = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		merged.set(c, off);
		off += c.length;
	}
	return merged;
}

export interface PublicFetchResult {
	response: Response;
	finalUrl: string;
	redirects: number;
}

/**
 * Fetch with manual redirect handling — every hop re-validated via
 * validateUrl. Relative Location headers resolve against the current URL.
 * Caller owns the returned body (use readBoundedText/Bytes, then release).
 */
export async function fetchWithRedirectValidation(
	url: string,
	init: RequestInit,
	maxRedirects: number = MAX_REDIRECTS,
): Promise<PublicFetchResult> {
	let current = url;
	const initialError = validateUrl(current);
	if (initialError) throw new Error(initialError);

	let redirects = 0;
	for (;;) {
		const response = await fetch(current, { ...init, redirect: "manual" });
		const status = response.status;
		if (status >= 300 && status < 400) {
			const location = response.headers.get("location");
			// Drain unneeded redirect body before following.
			try {
				await response.arrayBuffer().catch(() => undefined);
			} catch {
				// ignore
			}
			if (!location) return { response, finalUrl: current, redirects };
			if (redirects >= maxRedirects) {
				throw new Error(`Failed to read ${url}: too many redirects (>${maxRedirects})`);
			}
			let next: string;
			try {
				next = new URL(location, current).toString();
			} catch {
				throw new Error(`SSRF blocked: invalid redirect location`);
			}
			const hopError = validateUrl(next);
			if (hopError) throw new Error(hopError);
			current = next;
			redirects++;
			continue;
		}
		return { response, finalUrl: current, redirects };
	}
}
