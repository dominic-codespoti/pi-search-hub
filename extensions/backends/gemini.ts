import { searchGeminiCli } from "./gemini-cli.js";
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

const PROVIDER_CANDIDATES = ["google-antigravity", "opencode"];
const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
	"google-antigravity": "gemini-2.5-flash",
	opencode: "gemini-3-flash",
};
const LOGIN_HINT = "Run /login and select a Google provider (google-antigravity or opencode).";

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

	// Antigravity direct protocol first (works with /ag login, no host
	// model-catalog support needed). Errors fall through to the pi-ai path.
	try {
		return await searchGeminiCli(query, numResults, signal, backendConfig);
	} catch (cliError) {
		if (!isAuthMissingError(cliError)) {
			throw cliError;
		}
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
	const overrideModel = backendConfig?.model?.trim();
	const tried: string[] = [];
	let model: any;
	let apiKey: string | undefined;
	for (const candidate of PROVIDER_CANDIDATES) {
		const modelId = overrideModel || DEFAULT_MODEL_BY_PROVIDER[candidate];
		tried.push(`${candidate}/${modelId}`);
		const resolved = getModel(candidate, modelId);
		if (!resolved) continue;
		const key = await resolveProviderApiKey(candidate);
		if (!key) continue;
		model = resolved;
		apiKey = key;
		break;
	}
	if (!model) {
		throw new Error(
			`Gemini model not found (tried ${tried.join(", ")}). Set "model" for the gemini backend in search.json. ${LOGIN_HINT}`,
		);
	}

	return runLlmSearch({
		label: "Gemini",
		streamFn,
		model,
		query,
		numResults,
		signal: timeoutSignal(signal),
		...(apiKey ? { apiKey } : {}),
		injectSearch: injectGeminiSearchPayload,
		notSubmittedError: "Gemini search did not submit structured results",
		emptyResultsError: "Gemini search returned no valid URL results",
		cancelledError: "Gemini search cancelled",
	});
}

function isAuthMissingError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /credentials not found|API key|expired|401|re-login|\/ag login/i.test(message);
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
