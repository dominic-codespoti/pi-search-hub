import { timeoutSignal } from "../utils.js";
import type { BackendConfig, SearchResult } from "../types.js";
import {
	SUBMIT_SEARCH_RESULTS_TOOL,
	buildLlmSearchSystemPrompt,
	isRecord,
	loadPiAi,
	missingStreamError,
	normalizeSubmitSearchResults,
	pickFn,
	pickGetModel,
	resolveProviderApiKey,
} from "../shared-llm-results.js";

const PROVIDER_ID = "google-antigravity";
const DEFAULT_MODEL_ID = "gemini-2.5-flash";
const LOGIN_HINT = "Run /login and select the Google provider.";

/**
 * Gemini backend — mirrors `openai-codex.ts`, but drives a Gemini model
 * with Google Search grounding (`google_search`) injected at the payload
 * layer, then collects one structured `submit_search_results` call.
 *
 * Auth is Pi-managed (no apiKey in search.json). Uses `backendConfig.model`
 * when set. When the host cannot resolve auth or streams, it throws a
 * descriptive error so dispatch falls back to the next backend.
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

	const piAi = await loadPiAi();
	const streamFn = pickFn(piAi, [
		"streamGoogleGenerativeAI",
		"streamGoogle",
		"streamSimpleGoogle",
	]);
	const getModel = pickGetModel(piAi);
	if (!getModel || !streamFn) {
		throw missingStreamError("Gemini", piAi);
	}
	const apiKey = await resolveProviderApiKey(PROVIDER_ID);
	const modelId = backendConfig?.model?.trim() || DEFAULT_MODEL_ID;
	const model = getModel(PROVIDER_ID, modelId);
	if (!model) {
		throw new Error(
			`Gemini model not found: ${modelId} (provider ${PROVIDER_ID}). Set "model" for the gemini backend in search.json. ${LOGIN_HINT}`,
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
		...(apiKey ? { apiKey } : {}),
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
