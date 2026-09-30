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
	it("returns normalized results from a submit call", async () => {
		const { searchGeminiCli } = await import("./backends/gemini-cli.ts");
		const fetchMock = vi.fn().mockResolvedValue(
			sseResponse([
				textChunk("Researching now."),
				submitChunk([
					{ title: "Voynich", url: "https://example.com/voynich", snippet: "grounded summary" },
				]),
			]),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { results } = await searchGeminiCli("test query", 3);

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			title: "Voynich",
			url: "https://example.com/voynich",
			snippet: "grounded summary",
		});
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toContain("/v1internal:streamGenerateContent?alt=sse");
		const sent = JSON.parse(init.body);
		expect(sent.project).toBe("test-project");
		expect(sent.model).toBe("gemini-2.5-flash");
		expect(init.headers.Authorization).toBe("Bearer test-access");
	});

	it("converts a prose answer on the second turn", async () => {
		const { searchGeminiCli } = await import("./backends/gemini-cli.ts");
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(sseResponse([textChunk("See https://example.com/a for details.")]))
			.mockResolvedValueOnce(
				sseResponse([
					submitChunk([{ title: "A", url: "https://example.com/a", snippet: "details" }]),
				]),
			);
		vi.stubGlobal("fetch", fetchMock);

		const { results } = await searchGeminiCli("test query", 3);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(results[0].url).toBe("https://example.com/a");
		const secondSent = JSON.parse(fetchMock.mock.calls[1][1].body);
		expect(secondSent.request.contents).toHaveLength(2);
		expect(secondSent.request.tools).toHaveLength(1);
	});

	it("throws a login hint on 401", async () => {
		const { searchGeminiCli } = await import("./backends/gemini-cli.ts");
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("denied", { status: 401 })));

		await expect(searchGeminiCli("test query", 3)).rejects.toThrow("/ag login");
	});
});
