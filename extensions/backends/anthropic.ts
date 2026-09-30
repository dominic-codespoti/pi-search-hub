import { AuthStorage } from "@earendil-works/pi-coding-agent";

import { timeoutSignal } from "../utils.js";
import type { BackendConfig, SearchResult } from "../types.js";
import {
	SUBMIT_SEARCH_RESULTS_TOOL,
	buildLlmSearchSystemPrompt,
	isRecord,
	normalizeSubmitSearchResults,
} from "../shared-llm-results.js";

const DEFAULT_MODEL_ID = "claude-haiku-4-5";
const ANTHROPIC_SEARCH_TOOL_TYPE = "web_search_20250305";
const MAX_USES = 5;

/**
 * Anthropic backend — mirrors `openai-codex.ts`, but drives a Claude model
 * with Anthropic's server-side `web_search` tool injected at the payload
 * layer, then collects one structured `submit_search_results` call.
 *
 * Auth is Pi-managed (no apiKey in search.json): run /login and select
 * Anthropic. Uses `backendConfig.model` when set.
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

	const apiKey = await resolveAnthropicAccessToken();
	const { streamFn, getModel } = await resolveAnthropicStream();
	const modelId = backendConfig?.model?.trim() || DEFAULT_MODEL_ID;
	const model = getModel("anthropic", modelId);
	if (!model) {
		throw new Error(
			`Anthropic model not found: ${modelId}. Set "model" for the anthropic backend in search.json (e.g. claude-haiku-4-5).`,
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

async function resolveAnthropicAccessToken(): Promise<string> {
	const authStorage = AuthStorage.create();
	const apiKey = await authStorage.getApiKey("anthropic", {
		includeFallback: false,
	});

	if (!apiKey) {
		throw new Error("Anthropic authentication not found. Run /login and select Anthropic.");
	}

	return apiKey;
}

async function resolveAnthropicStream(): Promise<{
	streamFn: (...args: any[]) => { result: () => Promise<any> };
	getModel: (provider: string, id: string) => any;
}> {
	const piAi = (await import("@earendil-works/pi-ai")) as Record<string, any>;
	const streamFn = pickFn(piAi, [
		"streamAnthropicMessages",
		"streamAnthropic",
		"streamSimpleAnthropic",
	]);
	const getModel = pickGetModel(piAi);
	if (!getModel || !streamFn) {
		const available = Object.keys(piAi)
			.filter((k) => /stream/i.test(k))
			.sort();
		throw new Error(
			"Anthropic search is not supported natively by this pi build " +
				`(stream exports: ${available.length > 0 ? available.join(", ") : "none"}). ` +
				"Falls back to the next backend.",
		);
	}
	return { streamFn, getModel };
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
