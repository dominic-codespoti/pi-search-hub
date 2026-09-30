import { searchGeminiCli } from "./gemini-cli.js";
import type { BackendConfig, SearchResult } from "../types.js";
import type { StreamFn } from "../shared-llm-results.js";
import {
	isRecord,
	loadPiAi,
	missingStreamError,
	pickFn,
	pickGetModel,
	resolveHostModel,
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
	hostContext?: unknown,
): Promise<{ results: SearchResult[] }> {
	if (signal?.aborted) {
		throw new Error("Gemini search cancelled");
	}

	const overrideModel = backendConfig?.model?.trim();
	// 1. Host registry — the only path that sees extension providers
	//    (google-antigravity) with request-time auth. No explicit apiKey.
	const tried: string[] = [];
	const noteTried = (entry: string) => {
		if (!tried.includes(entry)) tried.push(entry);
	};
	let streamFn: StreamFn | undefined;
	let model: any;
	let apiKey: string | undefined;
	const hostProviders = overrideModel ? PROVIDER_CANDIDATES : ["google-antigravity"];
	for (const candidate of hostProviders) {
		const modelId = overrideModel || DEFAULT_MODEL_BY_PROVIDER[candidate];
		noteTried(`${candidate}/${modelId}`);
		const host = resolveHostModel(hostContext, candidate, modelId);
		if (!host) continue;
		model = host.model;
		streamFn = host.stream;
		break;
	}
	if (!model) {
		// 2. Antigravity direct protocol (stored OAuth creds, no catalog needed).
		try {
			return await searchGeminiCli(query, numResults, signal, backendConfig);
		} catch (cliError) {
			if (!isAuthMissingError(cliError)) {
				throw cliError;
			}
		}
		// 3. pi-ai static catalog (opencode zen etc.).
		const piAi = await loadPiAi();
		const piStream = pickFn(piAi, [
			"streamGoogleGenerativeAI",
			"streamGoogle",
			"streamSimpleGoogle",
		]);
		const getModel = pickGetModel(piAi);
		if (getModel && piStream) {
			for (const candidate of PROVIDER_CANDIDATES) {
				const modelId = overrideModel || DEFAULT_MODEL_BY_PROVIDER[candidate];
				noteTried(`${candidate}/${modelId}`);
				const resolved = getModel(candidate, modelId);
				if (!resolved) continue;
				const key = await resolveProviderApiKey(candidate);
				if (!key) continue;
				model = resolved;
				apiKey = key;
				streamFn = piStream;
				break;
			}
		}
	}
	if (!model || !streamFn) {
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
		timeoutMs: backendConfig?.timeout,
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
