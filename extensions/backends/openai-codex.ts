import type { Context, Model } from "@earendil-works/pi-ai";

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

// Re-export shared helpers so existing imports keep working.
export {
	SUBMIT_SEARCH_RESULTS_TOOL,
	isRecord,
	looksLikeDomainOrPath,
	normalizeHttpUrl,
	normalizeSearchResult,
	normalizeSubmitSearchResults,
	normalizeUrlForDedup,
} from "../shared-llm-results.js";

const PROVIDER_ID = "openai-codex";
const DEFAULT_MODEL_ID = "gpt-5.5";
const DEFAULT_SEARCH_CONTEXT_SIZE = "low";
const LOGIN_HINT = "Run /login and select OpenAI Codex.";

export async function searchOpenAICodex(
	query: string,
	numResults: number,
	signal?: AbortSignal,
	backendConfig?: BackendConfig,
): Promise<{ results: SearchResult[] }> {
	if (signal?.aborted) {
		throw new Error("OpenAI Codex search cancelled");
	}

	const piAi = await loadPiAi();
	const streamFn = pickFn(piAi, ["streamOpenAICodexResponses"]);
	const getModel = pickGetModel(piAi);
	if (!getModel || !streamFn) {
		throw missingStreamError("OpenAI Codex", piAi);
	}
	const apiKey = await resolveProviderApiKey(PROVIDER_ID);
	const modelId = backendConfig?.model?.trim() || DEFAULT_MODEL_ID;
	const model = getModel(PROVIDER_ID, modelId) as Model<"openai-codex-responses"> | undefined;
	if (!model) {
		throw new Error(`OpenAI Codex model not found: ${modelId}. ${LOGIN_HINT}`);
	}

	const context: Context = {
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
		transport: "sse",
		reasoningEffort: "minimal",
		textVerbosity: "low",
		onPayload: (payload: unknown) => injectCodexSearchPayload(payload),
	}).result();

	if (message.stopReason === "error") {
		throw new Error(message.errorMessage || "OpenAI Codex search failed");
	}
	if (message.stopReason === "aborted") {
		throw new Error("OpenAI Codex search cancelled");
	}

	const submitCall = message.content.find(
		(block) => block.type === "toolCall" && block.name === "submit_search_results",
	);
	if (!submitCall || submitCall.type !== "toolCall") {
		throw new Error("OpenAI Codex search did not submit structured results");
	}

	const results = normalizeSubmitSearchResults(submitCall.arguments, numResults);
	if (results.length === 0) {
		throw new Error("OpenAI Codex search returned no valid URL results");
	}

	return { results };
}

export function injectCodexSearchPayload(payload: unknown): unknown {
	const body = isRecord(payload) ? payload : {};
	const existingTools = Array.isArray(body.tools) ? body.tools.filter(Boolean) : [];
	const filteredTools = existingTools.filter((tool) => {
		if (!isRecord(tool)) return true;
		return tool.type !== "web_search";
	});

	body.tools = [
		{
			type: "web_search",
			external_web_access: true,
			search_context_size: DEFAULT_SEARCH_CONTEXT_SIZE,
		},
		...filteredTools,
	];
	body.tool_choice = "auto";
	body.parallel_tool_calls = false;

	const include = Array.isArray(body.include)
		? body.include.filter((value): value is string => typeof value === "string")
		: [];
	body.include = Array.from(new Set([...include, "web_search_call.action.sources"]));

	return body;
}
