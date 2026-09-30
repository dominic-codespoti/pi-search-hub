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

const PROVIDER_ID = "anthropic";
const DEFAULT_MODEL_ID = "claude-haiku-4-5";
const ANTHROPIC_SEARCH_TOOL_TYPE = "web_search_20250305";
const MAX_USES = 5;
const LOGIN_HINT = "Run /login and select Anthropic.";

/**
 * Anthropic backend — mirrors `openai-codex.ts`, but drives a Claude model
 * with Anthropic's server-side `web_search` tool injected at the payload
 * layer, then collects one structured `submit_search_results` call.
 *
 * Auth is Pi-managed (no apiKey in search.json). Uses `backendConfig.model`
 * when set. When the host cannot resolve auth or streams, it throws a
 * descriptive error so dispatch falls back to the next backend.
 */
export async function searchAnthropic(
	query: string,
	numResults: number,
	signal?: AbortSignal,
	backendConfig?: BackendConfig,
): Promise<{ results: SearchResult[] }> {
	if (signal?.aborted) {
		throw new Error("Anthropic search cancelled");
	}

	const piAi = await loadPiAi();
	const streamFn = pickFn(piAi, [
		"streamAnthropicMessages",
		"streamAnthropic",
		"streamSimpleAnthropic",
	]);
	const getModel = pickGetModel(piAi);
	if (!getModel || !streamFn) {
		throw missingStreamError("Anthropic", piAi);
	}
	const apiKey = await resolveProviderApiKey(PROVIDER_ID);
	const modelId = backendConfig?.model?.trim() || DEFAULT_MODEL_ID;
	const model = getModel(PROVIDER_ID, modelId);
	if (!model) {
		throw new Error(
			`Anthropic model not found: ${modelId}. Set "model" for the anthropic backend in search.json (e.g. claude-haiku-4-5). ${LOGIN_HINT}`,
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
		onPayload: (payload: unknown) => injectAnthropicSearchPayload(payload),
	}).result();

	if (message.stopReason === "error") {
		throw new Error(message.errorMessage || "Anthropic search failed");
	}
	if (message.stopReason === "aborted") {
		throw new Error("Anthropic search cancelled");
	}

	const submitCall = message.content.find(
		(block: { type: string; name?: string }) =>
			block.type === "toolCall" && block.name === "submit_search_results",
	);
	if (!submitCall || submitCall.type !== "toolCall") {
		throw new Error("Anthropic search did not submit structured results");
	}

	const results = normalizeSubmitSearchResults(submitCall.arguments, numResults);
	if (results.length === 0) {
		throw new Error("Anthropic search returned no valid URL results");
	}

	return { results };
}

export function injectAnthropicSearchPayload(payload: unknown): unknown {
	const body = isRecord(payload) ? payload : {};
	const existingTools = Array.isArray(body.tools) ? body.tools.filter(Boolean) : [];
	const filteredTools = existingTools.filter((tool) => {
		if (!isRecord(tool)) return true;
		return tool.type !== ANTHROPIC_SEARCH_TOOL_TYPE && tool.name !== "web_search";
	});

	body.tools = [
		{
			type: ANTHROPIC_SEARCH_TOOL_TYPE,
			name: "web_search",
			max_uses: MAX_USES,
		},
		...filteredTools,
	];

	return body;
}
