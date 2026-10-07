/**
 * Source-adapter contract — small native descriptors for site-specific
 * readers, separate from generic search BACKEND_DEFS.
 *
 * A source knows how to match URLs, how to probe its local prerequisites,
 * and (optionally) how to run one bounded live check against a fixed
 * public test target. No cookies, logins, installs, or paid transcription.
 */

import type { ProbeResult } from "../probe.js";

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
	/** True when this source handles the URL (exact host/subdomain match). */
	matchesUrl?: (url: string) => boolean;
	/** Local-only probe: executables/config, never network. */
	probe: () => Promise<SourceProbe>;
	/** Opt-in bounded live check against a fixed public target. */
	liveCheck?: (signal?: AbortSignal) => Promise<LiveCheckResult>;
	liveTarget?: string;
}
