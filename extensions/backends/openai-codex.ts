import { timeoutSignal } from "../utils.js";
import type { BackendConfig, SearchResult } from "../types.js";
import {
	isRecord,
	loadPiAi,
	missingStreamError,
	pickFn,
	pickGetModel,
	resolveProviderApiKey,
	runLlmSearch,
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
	const model = getModel(PROVIDER_ID, modelId);
	if (!model) {
		throw new Error(`OpenAI Codex model not found: ${modelId}. ${LOGIN_HINT}`);
	}

	return runLlmSearch({
		label: "OpenAI Codex",
		streamFn,
		model,
		query,
		numResults,
		signal: timeoutSignal(signal),
		...(apiKey ? { apiKey } : {}),
		extraOptions: {
			transport: "sse",
			reasoningEffort: backendConfig?.reasoningEffort?.trim() || "low",
			textVerbosity: "low",
		},
		injectSearch: injectCodexSearchPayload,
		notSubmittedError: "OpenAI Codex search did not submit structured results",
		emptyResultsError: "OpenAI Codex search returned no valid URL results",
		cancelledError: "OpenAI Codex search cancelled",
	});
}

export function injectCodexSearchPayload(payload: unknown): unknown {
	const body = isRecord(payload) ? payload : {};
	}
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
