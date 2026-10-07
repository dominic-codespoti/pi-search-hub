/**
 * Tests for typed reader errors — provider auth (terminal) vs target
 * denial/challenge (retryable).
 */
import { describe, it, expect } from "vitest";
import {
	providerAuthError,
	targetBlockedError,
	isRetryableReaderError,
	isKeyedProviderAuth,
	ReaderError,
} from "./errors.js";

describe("reader errors", () => {
	it("provider auth is fatal", () => {
		const err = providerAuthError("sofya", 401, "API error (401): Unauthorized");
		expect(err).toBeInstanceOf(ReaderError);
		expect(err.retryable).toBe(false);
		expect(err.origin).toBe("provider");
		expect(isRetryableReaderError(err)).toBe(false);
	});

	it("target blocked is retryable", () => {
		const err = targetBlockedError("jina", 403, "target returned 403");
		expect(err.retryable).toBe(true);
		expect(err.origin).toBe("target");
		expect(isRetryableReaderError(err)).toBe(true);
	});

	it("plain 401/403 stays conservative (fatal)", () => {
		expect(isRetryableReaderError(new Error("API error (401): Unauthorized"))).toBe(false);
		expect(isRetryableReaderError(new Error("API error (403): Forbidden"))).toBe(false);
	});

	it("plain 422/5xx/network errors retry", () => {
		expect(isRetryableReaderError(new Error("API error (422): no content"))).toBe(true);
		expect(isRetryableReaderError(new Error("API error (503): unavailable"))).toBe(true);
		expect(isRetryableReaderError(new Error("fetch failed"))).toBe(true);
	});

	it("cancellation and unsafe URLs never retry", () => {
		expect(isRetryableReaderError(new Error("Defuddle read cancelled"))).toBe(false);
		expect(isRetryableReaderError(new Error("SSRF blocked: private host"))).toBe(false);
	});

	it("only keyed readers treat upstream 401/403 as auth", () => {
		expect(isKeyedProviderAuth("sofya", 401)).toBe(true);
		expect(isKeyedProviderAuth("exa", 403)).toBe(true);
		expect(isKeyedProviderAuth("jina", 401)).toBe(false);
		expect(isKeyedProviderAuth("defuddle", 403)).toBe(false);
		expect(isKeyedProviderAuth("sofya", 422)).toBe(false);
	});
});
