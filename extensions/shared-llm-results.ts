import { Type } from "typebox";

import type { SearchResult } from "./types.js";

export const MAX_TOOL_RESULTS = 20;
export const MAX_TITLE_LENGTH = 200;
export const MAX_SNIPPET_LENGTH = 1000;

/**
 * Shared `submit_search_results` function tool for LLM-backed search backends
 * (openai-codex, anthropic, gemini). The model does hosted/native retrieval
 * itself, then calls this tool exactly once with structured results.
 */
export const SUBMIT_SEARCH_RESULTS_TOOL = {
	name: "submit_search_results",
	description: "Submit structured search results based on the available source evidence.",
	parameters: Type.Object({
		results: Type.Array(
			Type.Object({
				title: Type.String({
					description: "Page title or clearest source title for the URL.",
				}),
				url: Type.String({
					description: "Canonical http/https URL for the result.",
				}),
				snippet: Type.String({
					description:
						"A dense 450-500 character, multi-sentence paragraph with the most query-relevant facts, claims, numbers, dates, caveats, scope limits, and source-specific details from the available source evidence. Prefer completeness and concrete details over brevity while staying within normal search-result display. Shorter is acceptable only when evidence is thin. Do not write an opinion about usefulness.",
				}),
			}),
			{ maxItems: MAX_TOOL_RESULTS },
		),
	}),
} as const;

export function buildLlmSearchSystemPrompt(numResults: number): string {
	return [
		`Research the user's query with hosted web_search and call submit_search_results exactly once with at most ${numResults} results.`,
		"Return only real http/https URLs.",
		"Prefer primary sources.",
		"For snippet, write a dense 450-500 character, multi-sentence paragraph with the most query-relevant facts, claims, numbers, dates, caveats, scope limits, and source-specific details from the available source evidence. Prefer completeness and concrete details over brevity while staying within normal search-result display. Shorter is acceptable only when evidence is thin.",
		"Do not invent details or present unsupported text as source content.",
		"No prose.",
		"No internal references.",
	].join(" ");
}

export type PiAiModule = Record<string, any>;
export type StreamFn = (...args: any[]) => { result: () => Promise<any> };
export type GetModelFn = (provider: string, id: string) => any;

export async function loadPiAi(): Promise<PiAiModule> {
	try {
		return (await import("@earendil-works/pi-ai")) as PiAiModule;
	} catch (error) {
		throw new Error(
			`LLM search backends need @earendil-works/pi-ai from the pi host: ${(error as Error).message}. Falls back to the next backend.`,
		);
	}
}

export function pickFn(obj: PiAiModule, names: string[]): StreamFn | undefined {
	for (const name of names) {
		try {
			const value = obj[name];
			if (typeof value === "function") return value as StreamFn;
		} catch {
			// Strict mocks throw on unknown exports — try the next candidate.
		}
	}
	return undefined;
}

export function pickGetModel(obj: PiAiModule): GetModelFn | undefined {
	try {
		return typeof obj.getModel === "function" ? (obj.getModel as GetModelFn) : undefined;
	} catch {
		return undefined;
	}
}

export function missingStreamError(label: string, piAi: PiAiModule): Error {
	let available: string[];
	try {
		available = Object.keys(piAi)
			.filter((k) => /stream/i.test(k))
			.sort();
	} catch {
		available = [];
	}
	return new Error(
		`${label} search is not supported natively by this pi build ` +
			`(stream exports: ${available.length > 0 ? available.join(", ") : "none"}). ` +
			"Falls back to the next backend.",
	);
}

/**
 * Best-effort explicit credential for `providerId`. Works across host
 * generations: newer hosts expose `AuthStorage.create().getApiKey`, older
 * ones (0.87.x) expose sync `readStoredCredential`. Returns undefined when
 * neither exists — callers then omit `apiKey` and let the host resolve auth
 * itself (including OAuth refresh).
 */
export async function resolveProviderApiKey(providerId: string): Promise<string | undefined> {
	try {
		const codingAgent = (await import("@earendil-works/pi-coding-agent")) as Record<
			string,
			any
		>;
		try {
			const AuthStorage = codingAgent.AuthStorage;
			const store = AuthStorage?.create?.();
			if (store && typeof store.getApiKey === "function") {
				const key = await store.getApiKey(providerId, { includeFallback: false });
				if (typeof key === "string" && key.length > 0) return key;
			}
		} catch {
			// Try the legacy sync helper below.
		}
		try {
			if (typeof codingAgent.readStoredCredential === "function") {
				const cred = codingAgent.readStoredCredential(providerId);
				if (cred?.type === "api_key" && typeof cred.key === "string" && cred.key) {
					return cred.key;
				}
				if (cred?.type === "oauth" && typeof cred.access === "string" && cred.access) {
					return cred.access;
				}
			}
		} catch {
			// Fall through to host-resolved auth.
		}
	} catch {
		// Module unavailable (unit tests without the mock, minimal hosts).
	}
	return undefined;
}

export function normalizeSubmitSearchResults(args: unknown, numResults: number): SearchResult[] {
	if (!isRecord(args) || !Array.isArray(args.results)) {
		return [];
	}

	const limit = Math.max(1, Math.min(numResults, MAX_TOOL_RESULTS));
	const deduped = new Set<string>();
	const results: SearchResult[] = [];

	for (const rawResult of args.results) {
		const normalized = normalizeSearchResult(rawResult);
		if (!normalized) continue;

		const dedupeKey = normalizeUrlForDedup(normalized.url);
		if (deduped.has(dedupeKey)) continue;

		deduped.add(dedupeKey);
		results.push(normalized);
		if (results.length >= limit) break;
	}

	return results;
}

export function normalizeSearchResult(rawResult: unknown): SearchResult | null {
	if (!isRecord(rawResult)) return null;

	const url = normalizeHttpUrl(rawResult.url);
	if (!url) return null;

	const fallbackTitle = safeUrlHostname(url);
	const title = truncateText(cleanString(rawResult.title) || fallbackTitle, MAX_TITLE_LENGTH);
	const snippet = truncateText(cleanString(rawResult.snippet), MAX_SNIPPET_LENGTH);
	const content = truncateText(cleanString(rawResult.content), MAX_SNIPPET_LENGTH);
	const display = snippet || content;
	if (!display) return null;

	return {
		title,
		url,
		snippet: display,
		content: display,
	};
}

export function normalizeHttpUrl(value: unknown): string | undefined {
	const input = cleanString(value);
	if (!input) return undefined;

	const candidate = hasUrlScheme(input)
		? input
		: looksLikeDomainOrPath(input)
			? `https://${input}`
			: input;

	try {
		const url = new URL(candidate);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return undefined;
		}
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

export function normalizeUrlForDedup(url: string): string {
	try {
		const normalized = new URL(url);
		normalized.hash = "";
		normalized.pathname = normalized.pathname.replace(/\/+$/, "") || "/";
		return normalized.toString().toLowerCase();
	} catch {
		return url.trim().toLowerCase();
	}
}

function safeUrlHostname(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

function cleanString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function truncateText(value: string, maxLength: number): string {
	return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function hasUrlScheme(value: string): boolean {
	return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
}

export function looksLikeDomainOrPath(value: string): boolean {
	return /^[^\s/]+\.[^\s]+(?:\/.*)?$/.test(value);
}

export function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null;
}
