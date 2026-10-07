/**
 * Typed reader errors — distinguish provider-auth failures (terminal) from
 * target denial/challenge (retryable via the next reader).
 *
 * Background: the previous `isRetryableError` treated any "401|403" message
 * as fatal, conflating a bad Sofya/Exa API key (upstream) with a site that
 * returned 403 to Jina/Defuddle (target). Only keyed-reader upstream auth
 * is terminal; target denial retries. Unknown 401/403 stays conservative
 * (fatal) unless explicitly marked as a target failure.
 */

export type ReaderErrorOrigin = "provider" | "target" | "local";
export type ReaderErrorReason =
	| "auth"
	| "challenge"
	| "blocked"
	| "network"
	| "timeout"
	| "empty"
	| "too-large"
	| "cancelled"
	| "unsafe-url"
	| "unknown";

/** Readers whose 401/403 from the provider endpoint means a bad API key. */
export const KEYED_READERS = new Set(["sofya", "exa"]);

export class ReaderError extends Error {
	readonly reader: string;
	readonly origin: ReaderErrorOrigin;
	readonly reason: ReaderErrorReason;
	readonly status?: number;
	readonly retryable: boolean;

	constructor(
		reader: string,
		message: string,
		opts: {
			origin: ReaderErrorOrigin;
			reason: ReaderErrorReason;
			status?: number;
			retryable: boolean;
		},
	) {
		super(message);
		this.name = "ReaderError";
		this.reader = reader;
		this.origin = opts.origin;
		this.reason = opts.reason;
		this.status = opts.status;
		this.retryable = opts.retryable;
	}
}

/** Upstream provider rejected our credentials — terminal, do not retry. */
export function providerAuthError(reader: string, status: number, message: string): ReaderError {
	return new ReaderError(reader, message, {
		origin: "provider",
		reason: "auth",
		status,
		retryable: false,
	});
}

/** Target site denied/blocked the fetch — retryable via the next reader. */
export function targetBlockedError(
	reader: string,
	status: number | undefined,
	message: string,
	reason: ReaderErrorReason = "blocked",
): ReaderError {
	return new ReaderError(reader, message, {
		origin: "target",
		reason,
		status,
		retryable: true,
	});
}

/**
 * Classify an unknown thrown value for the fallback chain.
 * ReaderError carries its own verdict; legacy plain Errors fall back to the
 * historic message heuristic, except cancellation/unsafe-URL are terminal.
 */
export function isRetryableReaderError(err: unknown): boolean {
	if (err instanceof ReaderError) return err.retryable;
	if (err instanceof Error) {
		const msg = err.message;
		if (/cancelled|aborted/i.test(msg)) return false;
		if (/SSRF blocked|unsafe URL|invalid URL/i.test(msg)) return false;
		if (/\b(401|403)\b/.test(msg) || /unauthorized|forbidden/i.test(msg)) return false;
		return true;
	}
	return true;
}

/**
 * Decide whether a provider-endpoint HTTP status is terminal auth.
 * Only keyed readers (sofya/exa) treat upstream 401/403 as auth-terminal.
 */
export function isKeyedProviderAuth(reader: string, status: number): boolean {
	return (status === 401 || status === 403) && KEYED_READERS.has(reader);
}
