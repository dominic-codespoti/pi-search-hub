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
