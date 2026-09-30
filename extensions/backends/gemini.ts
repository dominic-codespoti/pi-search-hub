import { AuthStorage } from "@earendil-works/pi-coding-agent";

import { timeoutSignal } from "../utils.js";
import type { BackendConfig, SearchResult } from "../types.js";
import {
	SUBMIT_SEARCH_RESULTS_TOOL,
	buildLlmSearchSystemPrompt,
	isRecord,
	normalizeSubmitSearchResults,
} from "../shared-llm-results.js";

const DEFAULT_MODEL_ID = "gemini-2.5-flash";

/**
 * Gemini backend — mirrors `openai-codex.ts`, but drives a Gemini model
 * with Google Search grounding (`google_search`) injected at the payload
 * layer, then collects one structured `submit_search_results` call.
 *
 * Auth is Pi-managed (no apiKey in search.json): run /login and select the
 * Google provider. Uses `backendConfig.model` when set.
 */
export async function searchGemini(
	query: string,
	numResults: number,
	signal?: AbortSignal,
	backendConfig?: BackendConfig,
): Promise<{ results: SearchResult[] }> {
	if (signal?.aborted) {
		throw new Error("Gemini search cancelled");
	}

	const apiKey = await resolveGeminiAccessToken();
	const { streamFn, getModel, provider } = await resolveGeminiStream();
	const modelId = backendConfig?.model?.trim() || DEFAULT_MODEL_ID;
	const model = getModel(provider, modelId);
	if (!model) {
		throw new Error(
			`Gemini model not found: ${modelId} (provider ${provider}). Set "model" for the gemini backend in search.json.`,
		);
	}

	const context = {
		systemPrompt: buildLlmSearchSystemPrompt(numResults),
		messages: [
			{
				role: "user",
				content: query,
				timestamp: Date.now(),
			},
		],
		tools: [SUBMIT_SEARCH_RESULTS_TOOL],
	};

	const message = await streamFn(model, context, {
		apiKey,
		signal: timeoutSignal(signal),
		onPayload: (payload: unknown) => injectGeminiSearchPayload(payload),
	}).result();

	if (message.stopReason === "error") {
		throw new Error(message.errorMessage || "Gemini search failed");
	}
	if (message.stopReason === "aborted") {
		throw new Error("Gemini search cancelled");
	}

	const submitCall = message.content.find(
		(block: { type: string; name?: string }) =>
			block.type === "toolCall" && block.name === "submit_search_results",
	);
	if (!submitCall || submitCall.type !== "toolCall") {
		throw new Error("Gemini search did not submit structured results");
	}

	const results = normalizeSubmitSearchResults(submitCall.arguments, numResults);
	if (results.length === 0) {
		throw new Error("Gemini search returned no valid URL results");
	}

	return { results };
}


function pickFn(obj: Record<string, any>, names: string[]): ((...args: any[]) => { result: () => Promise<any> }) | undefined {
	for (const name of names) {
		try {
			const value = obj[name];
			if (typeof value === "function") return value;
		} catch {
			// Strict mocks throw on unknown exports — try the next candidate.
		}
	}
	return undefined;
}

function pickGetModel(obj: Record<string, any>): ((provider: string, id: string) => any) | undefined {
	try {
		return typeof obj.getModel === "function" ? obj.getModel : undefined;
	} catch {
		return undefined;
	}
}

async function resolveGeminiAccessToken(): Promise<string> {
	const authStorage = AuthStorage.create();
	const apiKey = await authStorage.getApiKey("google-antigravity", {
		includeFallback: false,
	});

	if (!apiKey) {
		throw new Error(
			"Google authentication not found. Run /login and select the Google provider.",
		);
	}

	return apiKey;
}

async function resolveGeminiStream(): Promise<{
	streamFn: (...args: any[]) => { result: () => Promise<any> };
	getModel: (provider: string, id: string) => any;
	provider: string;
}> {
	const piAi = (await import("@earendil-works/pi-ai")) as Record<string, any>;
	const streamFn = pickFn(piAi, [
		"streamGoogleGenerativeAI",
		"streamGoogle",
		"streamSimpleGoogle",
	]);
	const getModel = pickGetModel(piAi);
	if (!getModel || !streamFn) {
		const available = Object.keys(piAi)
			.filter((k) => /stream/i.test(k))
			.sort();
		throw new Error(
			"Gemini search is not supported natively by this pi build " +
				`(stream exports: ${available.length > 0 ? available.join(", ") : "none"}). ` +
				"Falls back to the next backend.",
		);
	}
	return { streamFn, getModel, provider: "google-antigravity" };
}

export function injectGeminiSearchPayload(payload: unknown): unknown {
	const body = isRecord(payload) ? payload : {};
	const config = isRecord(body.config) ? body.config : {};
	const existingTools = Array.isArray(config.tools) ? config.tools.filter(Boolean) : [];
	const hasGoogleSearch = existingTools.some(
		(tool) => isRecord(tool) && "google_search" in tool,
	);

	config.tools = hasGoogleSearch ? existingTools : [...existingTools, { google_search: {} }];
	body.config = config;

	return body;
}
