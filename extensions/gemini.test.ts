import { beforeEach, describe, expect, it, vi } from "vitest";

const { streamGoogleMock, getModelMock } = vi.hoisted(() => ({
	streamGoogleMock: vi.fn(),
	getModelMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	AuthStorage: {
		create: () => ({
			getApiKey: async () => "test-api-key",
		}),
	},
}));

vi.mock("@earendil-works/pi-ai", () => ({
	getModel: getModelMock,
	streamGoogle: streamGoogleMock,
}));

const { searchGeminiCliMock } = vi.hoisted(() => ({
	searchGeminiCliMock: vi.fn(),
}));

vi.mock("./backends/gemini-cli.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./backends/gemini-cli.ts")>();
	return {
		...actual,
		searchGeminiCli: searchGeminiCliMock,
	};
});

vi.mock("typebox", () => ({
	Type: {
		Object: (value: unknown) => value,
		String: (value?: unknown) => value ?? {},
		Optional: (value: unknown) => value,
		Array: (value: unknown, options?: unknown) => ({ value, options }),
	},
}));

beforeEach(() => {
	searchGeminiCliMock.mockReset();
	// Default: direct CLI path reports missing creds so the pi-ai path is exercised.
	searchGeminiCliMock.mockRejectedValue(new Error("Google Antigravity credentials not found. Run /ag login."));
	streamGoogleMock.mockReset();
	getModelMock.mockReset();
	getModelMock.mockReturnValue({ id: "gemini-2.5-flash" });
	streamGoogleMock.mockReturnValue({
		result: async () => ({ stopReason: "error", errorMessage: "not used in helper tests", content: [] }),
	});
});

describe("gemini helpers", () => {
	it("searchGemini asks Gemini for rich source-grounded snippets", async () => {
		const { searchGemini } = await import("./backends/gemini.ts");

		await expect(searchGemini("test query", 3)).rejects.toThrow("not used in helper tests");

		const [, context] = streamGoogleMock.mock.calls[0];
		const submitTool = context.tools[0];
		const resultSchema = submitTool.parameters.results.value;

		expect(getModelMock).toHaveBeenCalledWith("google-antigravity", "gemini-2.5-flash");
		expect(context.systemPrompt).toContain("450-500 character");
		expect(context.systemPrompt).toContain("normal search-result display");
		expect(context.systemPrompt).not.toContain("For content");
		expect(resultSchema.snippet.description).toContain("450-500 character");
		expect(resultSchema.snippet.description).toContain("Prefer completeness and concrete details over brevity");
		expect("content" in resultSchema).toBe(false);
	});

	it("searchGemini prefers the direct Antigravity protocol when it succeeds", async () => {
		const { searchGemini } = await import("./backends/gemini.ts");
		searchGeminiCliMock.mockResolvedValue({ results: [{ title: "T", url: "https://example.com/", snippet: "S", content: "S" }] });

		const { results } = await searchGemini("test query", 3);

		expect(searchGeminiCliMock).toHaveBeenCalledWith("test query", 3, undefined, undefined);
		expect(results).toHaveLength(1);
		expect(getModelMock).not.toHaveBeenCalled();
	});

	it("searchGemini resolves Antigravity through the host registry", async () => {
		const { searchGemini } = await import("./backends/gemini.ts");
		const hostModel = { id: "gemini-2.5-flash", api: "google-gemini-cli", provider: "google-antigravity" };
		const hostStream = vi.fn().mockReturnValue({
			result: async () => ({
				stopReason: "stop",
				content: [
					{
						type: "toolCall",
						name: "submit_search_results",
						arguments: {
							results: [{ title: "Host", url: "https://example.com/host", snippet: "via registry" }],
						},
					},
				],
			}),
		});
		const hostContext = {
			modelRegistry: {
				find: vi.fn((provider: string) => (provider === "google-antigravity" ? hostModel : undefined)),
				stream: hostStream,
			},
		};

		const { results } = await searchGemini("test query", 3, undefined, undefined, hostContext);

		expect(results).toHaveLength(1);
		expect(results[0].url).toBe("https://example.com/host");
		expect(searchGeminiCliMock).not.toHaveBeenCalled();
		expect(getModelMock).not.toHaveBeenCalled();
		const [modelArg, , optionsArg] = hostStream.mock.calls[0];
		expect(modelArg).toBe(hostModel);
		expect(optionsArg.apiKey).toBeUndefined();
	});

	it("searchGemini falls past non-auth CLI errors without trying pi-ai", async () => {
		const { searchGemini } = await import("./backends/gemini.ts");
		searchGeminiCliMock.mockRejectedValue(new Error("Gemini search returned no valid URL results"));

		await expect(searchGemini("test query", 3)).rejects.toThrow("no valid URL results");
		expect(getModelMock).not.toHaveBeenCalled();
	});

	it("injectGeminiSearchPayload targets request.tools for CLI-shaped bodies", async () => {
		const { injectGeminiSearchPayload } = await import("./backends/gemini.ts");

		const payload = injectGeminiSearchPayload({
			project: "p",
			model: "m",
			request: { contents: [], tools: [{ functionDeclarations: [] }] },
		}) as { request: { tools: unknown[] } };

		expect(payload.request.tools).toEqual([{ google_search: {} }]);
	});

	it("injectGeminiSubmitPayload overwrites request.tools with the plain declaration", async () => {
		const { injectGeminiSubmitPayload } = await import("./backends/gemini.ts");

		const payload = injectGeminiSubmitPayload({
			project: "p",
			request: { contents: [], tools: [{ functionDeclarations: [{ name: "x" }] }] },
		}) as { request: { tools: Array<{ functionDeclarations: Array<{ name: string }> }> } };

		expect(payload.request.tools).toHaveLength(1);
		expect(payload.request.tools[0].functionDeclarations[0].name).toBe("submit_search_results");
	});

	it("searchGemini honors backendConfig.model", async () => {
		const { searchGemini } = await import("./backends/gemini.ts");

		await expect(
			searchGemini("test query", 3, undefined, { model: "gemini-2.5-pro" }),
		).rejects.toThrow("not used in helper tests");

		expect(getModelMock).toHaveBeenCalledWith("google-antigravity", "gemini-2.5-pro");
	});

	it("searchGemini throws a clear error when the model is unknown", async () => {
		const { searchGemini } = await import("./backends/gemini.ts");
		getModelMock.mockReturnValue(undefined);

		await expect(searchGemini("test query", 3)).rejects.toThrow(
			"Gemini model not found (tried google-antigravity/gemini-2.5-flash, opencode/gemini-3-flash)",
		);
	});

	it("injectGeminiSearchPayload adds grounding and preserves existing tools", async () => {
		const { injectGeminiSearchPayload } = await import("./backends/gemini.ts");

		const payload = injectGeminiSearchPayload({
			config: {
				tools: [{ functionDeclarations: [{ name: "submit_search_results" }] }],
			},
		}) as {
			config: { tools: Array<Record<string, unknown>> };
		};

		expect(payload.config.tools).toHaveLength(2);
		expect(payload.config.tools[0]).toMatchObject({
			functionDeclarations: [{ name: "submit_search_results" }],
		});
		expect(payload.config.tools[1]).toMatchObject({ google_search: {} });
	});

	it("injectGeminiSearchPayload does not duplicate grounding", async () => {
		const { injectGeminiSearchPayload } = await import("./backends/gemini.ts");

		const payload = injectGeminiSearchPayload({
			config: { tools: [{ google_search: {} }] },
		}) as {
			config: { tools: Array<Record<string, unknown>> };
		};

		expect(payload.config.tools).toHaveLength(1);
	});
});
