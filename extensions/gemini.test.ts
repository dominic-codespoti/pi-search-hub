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

vi.mock("typebox", () => ({
	Type: {
		Object: (value: unknown) => value,
		String: (value?: unknown) => value ?? {},
		Optional: (value: unknown) => value,
		Array: (value: unknown, options?: unknown) => ({ value, options }),
	},
}));

beforeEach(() => {
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
