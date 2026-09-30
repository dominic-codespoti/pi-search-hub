import { beforeEach, describe, expect, it, vi } from "vitest";

const futureExpiry = Date.now() + 3_600_000;

vi.mock("@earendil-works/pi-coding-agent", () => ({
	readStoredCredential: () => ({
		type: "oauth",
		access: "test-access",
		projectId: "test-project",
		expires: futureExpiry,
	}),
}));

vi.mock("typebox", () => ({
	Type: {
		Object: (value: unknown) => value,
		String: (value?: unknown) => value ?? {},
		Optional: (value: unknown) => value,
		Array: (value: unknown, options?: unknown) => ({ value, options }),
	},
}));

function sseResponse(chunks: unknown[]): Response {
	const lines = chunks.map((c) => `data: ${JSON.stringify({ response: c })}`);
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(`${lines.join("\n")}\n`));
			controller.close();
		},
	});
	return new Response(body, { status: 200 });
}

function submitChunk(results: unknown[]) {
	return {
		candidates: [
			{
				content: {
					parts: [{ functionCall: { name: "submit_search_results", args: { results } } }],
				},
			},
		],
	};
}

function textChunk(text: string) {
	return { candidates: [{ content: { parts: [{ text }] } }] };
}

beforeEach(() => {
	vi.unstubAllGlobals();
});

describe("gemini-cli backend", () => {
	it("grounds with search-only then converts via submit-only turn", async () => {
		const { searchGeminiCli } = await import("./backends/gemini-cli.ts");
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(sseResponse([textChunk("See https://example.com/voynich for details.")]))
			.mockResolvedValueOnce(
				sseResponse([
					submitChunk([
						{ title: "Voynich", url: "https://example.com/voynich", snippet: "grounded summary" },
					]),
				]),
			);
		vi.stubGlobal("fetch", fetchMock);

		const { results } = await searchGeminiCli("test query", 3);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			title: "Voynich",
			url: "https://example.com/voynich",
			snippet: "grounded summary",
		});

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toContain("/v1internal:streamGenerateContent?alt=sse");
		expect(init.headers.Authorization).toBe("Bearer test-access");
		const firstSent = JSON.parse(init.body);
		expect(firstSent.project).toBe("test-project");
		expect(firstSent.model).toBe("gemini-2.5-flash");
		expect(firstSent.request.tools).toEqual([{ google_search: {} }]);

		const secondSent = JSON.parse(fetchMock.mock.calls[1][1].body);
		expect(secondSent.request.contents).toHaveLength(3);
		expect(secondSent.request.tools).toHaveLength(1);
		expect(secondSent.request.tools[0].functionDeclarations[0].name).toBe(
			"submit_search_results",
		);
	});

	it("throws when grounding returns no answer", async () => {
		const { searchGeminiCli } = await import("./backends/gemini-cli.ts");
		const fetchMock = vi.fn().mockResolvedValueOnce(sseResponse([]));
		vi.stubGlobal("fetch", fetchMock);

		await expect(searchGeminiCli("test query", 3)).rejects.toThrow("no grounded answer");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("throws a login hint on 401", async () => {
		const { searchGeminiCli } = await import("./backends/gemini-cli.ts");
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("denied", { status: 401 })));

		await expect(searchGeminiCli("test query", 3)).rejects.toThrow("/ag login");
	});
});
