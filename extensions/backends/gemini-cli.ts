import { timeoutSignal } from "../utils.js";
import type { BackendConfig, SearchResult } from "../types.js";
import {
	buildLlmSearchSystemPrompt,
	normalizeSubmitSearchResults,
} from "../shared-llm-results.js";

const PROVIDER_ID = "google-antigravity";
const DEFAULT_MODEL_ID = "gemini-2.5-flash";
const LOGIN_HINT = "Run /ag login (or restart the pi session) to refresh Google Antigravity credentials.";

// Cloud Code Assist endpoints (production first, daily sandbox fallback).
const ENDPOINTS = [
	"https://cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
];

// Plain OpenAPI-safe JSON schema for the submit tool — hand-written so no
// TypeBox conversion or Cloud-Code-Assist sanitization is needed.
const SUBMIT_DECLARATION = {
	name: "submit_search_results",
	description: "Submit structured search results based on the available source evidence.",
	parameters: {
		type: "object",
		properties: {
			results: {
				type: "array",
				items: {
					type: "object",
					properties: {
						title: { type: "string" },
						url: { type: "string" },
						snippet: { type: "string" },
					},
					required: ["title", "url", "snippet"],
				},
			},
		},
		required: ["results"],
	},
};

/**
 * Gemini search via the Antigravity (Cloud Code Assist) wire protocol,
 * spoken directly: POST {endpoint}/v1internal:streamGenerateContent?alt=sse
 * with the stored OAuth access token + projectId. No pi-ai stream needed,
 * so this works wherever the user is logged in via /ag login.
 *
 * Same two-step shape as the other LLM backends: grounded retrieval with
 * google_search + submit_search_results, then a prose-to-structured
 * follow-up turn when the model answers in text.
 */
export async function searchGeminiCli(
	query: string,
	numResults: number,
	signal?: AbortSignal,
	backendConfig?: BackendConfig,
): Promise<{ results: SearchResult[] }> {
	if (signal?.aborted) {
		throw new Error("Gemini search cancelled");
	}
	const cred = await readAntigravityCredential();
	const modelId = backendConfig?.model?.trim() || DEFAULT_MODEL_ID;
	const systemPrompt = buildLlmSearchSystemPrompt(numResults);

	// Cloud Code Assist rejects built-in google_search combined with function
	// calling in one turn, so: turn 1 grounds with search only, turn 2 converts
	// the grounded answer into the structured submit call (functions only).
	const first = await streamTurn(cred, modelId, systemPrompt, [
		{ role: "user", parts: [{ text: query }] },
	], "search", signal);
	const evidence = first.text.trim();
	if (!evidence) {
		throw new Error("Gemini search returned no grounded answer");
	}
	const second = await streamTurn(
		cred,
		modelId,
		"Convert the research in this conversation into exactly one submit_search_results call. " +
			systemPrompt,
		[
			{ role: "user", parts: [{ text: query }] },
			{ role: "model", parts: [{ text: evidence.slice(0, 8000) }] },
			{ role: "user", parts: [{ text: "Convert the above research into exactly one submit_search_results call now." }] },
		],
		"submit",
		signal,
	);
	const converted = extractSubmitResults(second, numResults);
	if (converted) return { results: converted };
	throw new Error("Gemini search returned no valid URL results");
}

interface AntigravityCred {
	access: string;
	projectId: string;
}

async function readAntigravityCredential(): Promise<AntigravityCred> {
	let codingAgent: Record<string, any> | undefined;
	try {
		codingAgent = (await import("@earendil-works/pi-coding-agent")) as Record<string, any>;
	} catch {
		codingAgent = undefined;
	}
	let cred: any;
	try {
		const store = codingAgent?.AuthStorage?.create?.();
		if (store && typeof store.read === "function") {
			cred = await store.read(PROVIDER_ID);
		}
	} catch {
		cred = undefined;
	}
	if (!cred?.access) {
		try {
			if (typeof codingAgent?.readStoredCredential === "function") {
				cred = codingAgent.readStoredCredential(PROVIDER_ID);
			}
		} catch {
			// fall through to disk below
		}
	}
	// Fall back to auth.json on disk (same file the host reads).
	if (!cred?.access) {
		try {
			const { readFileSync } = await import("node:fs");
			const { join } = await import("node:path");
			const home = process.env.HOME || "~";
			const authData = JSON.parse(readFileSync(join(home, ".pi/agent/auth.json"), "utf-8"));
			cred = authData?.[PROVIDER_ID];
		} catch {
			// fall through to the login error below
		}
	}
	if (cred?.type === "api_key" && cred.key) {
		throw new Error(
			`Gemini search needs an Antigravity OAuth credential with projectId, found an API key. ${LOGIN_HINT}`,
		);
	}
	if (typeof cred?.access !== "string" || !cred.access || typeof cred?.projectId !== "string" || !cred.projectId) {
		throw new Error(`Google Antigravity credentials not found. ${LOGIN_HINT}`);
	}
	if (typeof cred.expires === "number") {
		const expiresMs = cred.expires > 1e12 ? cred.expires : cred.expires * 1000;
		if (Date.now() >= expiresMs - 60_000) {
			throw new Error(
				`Google Antigravity access token expired. Restart the pi session (auto-refresh on start) or ${LOGIN_HINT}`,
			);
		}
	}
	return { access: cred.access, projectId: cred.projectId };
}

interface TurnResult {
	text: string;
	calls: Array<{ name: string; args: unknown }>;
}

async function streamTurn(
	cred: AntigravityCred,
	modelId: string,
	systemPrompt: string,
	contents: Array<{ role: string; parts: Array<{ text: string }> }>,
	mode: "search" | "submit",
	signal?: AbortSignal,
): Promise<TurnResult> {
	const tools: Array<Record<string, unknown>> =
		mode === "search"
			? [{ google_search: {} }]
			: [{ functionDeclarations: [SUBMIT_DECLARATION] }];
	const body = {
		project: cred.projectId,
		model: modelId,
		request: {
			contents,
			systemInstruction: { parts: [{ text: systemPrompt }] },
			tools,
		},
		userAgent: "pi-search-hub",
		requestId: `pisearch-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
	};
	const headers: Record<string, string> = {
		Authorization: `Bearer ${cred.access}`,
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		"User-Agent": "antigravity/1.25.0",
		"X-Goog-Api-Client": "gl-node/22.17.0",
	};

	let lastError = "";
	for (const endpoint of ENDPOINTS) {
		const response = await fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: timeoutSignal(signal),
		});
		if (response.status === 401) {
			throw new Error(
				`Google Antigravity rejected the access token (401). Restart the pi session or ${LOGIN_HINT}`,
			);
		}
		if (response.status === 404) {
			lastError = `Model "${modelId}" not found on ${endpoint} (404).`;
			continue;
		}
		if (!response.ok || !response.body) {
			lastError = `Cloud Code Assist error (${response.status}): ${(await response.text().catch(() => "")).slice(0, 200)}`;
			continue;
		}
		return parseSseTurn(response.body, signal);
	}
	throw new Error(lastError || "Gemini search failed on all endpoints");
}

async function parseSseTurn(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): Promise<TurnResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	const calls: Array<{ name: string; args: unknown }> = [];
	try {
		for (;;) {
			if (signal?.aborted) {
				throw new Error("Gemini search cancelled");
			}
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.startsWith("data:")) continue;
				const jsonStr = line.slice(5).trim();
				if (!jsonStr) continue;
				let chunk: any;
				try {
					chunk = JSON.parse(jsonStr);
				} catch {
					continue;
				}
				const parts = chunk?.response?.candidates?.[0]?.content?.parts;
				if (!Array.isArray(parts)) continue;
				for (const part of parts) {
					if (typeof part?.text === "string") {
						text += part.text;
					}
					if (part?.functionCall && typeof part.functionCall.name === "string") {
						calls.push({ name: part.functionCall.name, args: part.functionCall.args ?? {} });
					}
				}
			}
		}
	} finally {
		try {
			await reader.cancel().catch(() => {});
		} catch {
			// ignore teardown errors
		}
	}
	return { text, calls };
}

function extractSubmitResults(turn: TurnResult, numResults: number): SearchResult[] | undefined {
	for (const call of turn.calls) {
		if (call.name !== "submit_search_results") continue;
		const results = normalizeSubmitSearchResults(call.args, numResults);
		if (results.length > 0) return results;
	}
	return undefined;
}
