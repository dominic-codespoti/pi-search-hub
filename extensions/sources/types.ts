/**
 * Source-adapter contract — small native descriptors for site-specific
 * readers, separate from generic search BACKEND_DEFS.
 *
 * A source describes its local prerequisites and (optionally) one bounded
 * live check against a fixed public test target. Readers are always chosen
 * explicitly via web_read's reader param — there is no automatic URL routing.
 * No cookies, logins, installs, or paid transcription.
 */

export type SourceOperation = "search" | "read";
export type SourceStatus = "ok" | "warn" | "off" | "error";

export interface SourceProbe {
	status: SourceStatus;
	message: string;
	remedy?: string;
}

export interface LiveCheckResult {
	ok: boolean;
	target: string;
	message: string;
}

export interface SourceDescriptor {
	id: string;
	label: string;
	operations: SourceOperation[];
	/** Local-only probe: executables/config, never network. */
	probe: () => Promise<SourceProbe>;
	/** Opt-in bounded live check against a fixed public target. */
	liveCheck?: (signal?: AbortSignal) => Promise<LiveCheckResult>;
	liveTarget?: string;
}
