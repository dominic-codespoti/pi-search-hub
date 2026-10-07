/**
 * YouTube captions reader — keyless, local transcript extraction via yt-dlp.
 *
 * Explicit source reader for `web_read(url, reader: "youtube", language)`.
 * Two bounded yt-dlp steps in a private temp dir: (1) `--dump-single-json`
 * track listing, (2) subtitle-file download for the selected language. No
 * audio/video download, no comments, no transcription fallback.
 *
 * Security boundaries: fixed argv via execFile (no shell; the canonical
 * watch URL is rebuilt from a validated 11-char video ID, never the raw
 * user string), minimal allowlisted child environment (no API keys, no
 * proxy credentials, temp HOME), private temp cwd removed in a finally
 * block, stdout/stderr/file byte caps, total wall time ~60s. yt-dlp is
 * trusted code, not an OS sandbox: a malicious yt-dlp binary itself is out
 * of scope (same trust as any PATH executable). All failures are terminal
 * ReaderErrors (retryable:false) so a transcript request can never silently
 * succeed with watch-page text via generic fallback.
 */
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ReaderError } from "../readers/errors.js";

export const YOUTUBE_MAX_WALL_MS = 60_000;
const METADATA_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const STDOUT_CAP = 4 * 1024 * 1024;
const STDERR_CAP = 64 * 1024;
const FILE_CAP = 2 * 1024 * 1024;
/** Extensions we can parse. Preference order for downloaded files. */
const PARSEABLE_EXTS = ["vtt", "json3", "srt"] as const;
/** Caption origins we accept if a track URL ever needs direct fetching. */
export const CAPTION_HOSTS = ["youtube.com", "youtu.be", "googlevideo.com"];

export interface Cue {
	start: number;
	end: number;
	text: string;
}

export interface TrackSelection {
	/** Language key from the yt-dlp listing (e.g. "en", "en-US"). */
	lang: string;
	manual: boolean;
	translated: boolean;
}

interface TrackEntry {
	url?: string;
	ext?: string;
	name?: string;
	tlang?: string;
	lang?: string;
}

interface MetaJson {
	title?: string;
	channel?: string;
	duration_string?: string;
	duration?: number;
	upload_date?: string;
	language?: string;
	subtitles?: Record<string, TrackEntry[]>;
	automatic_captions?: Record<string, TrackEntry[]>;
}

function whichSync(cmd: string): string | null {
	const pathEnv = process.env.PATH ?? "";
	for (const dir of pathEnv.split(sep === "\\" ? ";" : ":")) {
		if (!dir) continue;
		try {
			const full = join(dir, cmd);
			accessSync(full, constants.X_OK);
			return full;
		} catch {
			// continue
		}
	}
	return null;
}

function youtubeError(message: string): ReaderError {
	return new ReaderError("youtube", message, {
		origin: "target",
		reason: "blocked",
		retryable: false,
	});
}

/**
 * Extract a single-video ID from recognised public YouTube URLs.
 * Rejects playlists-only URLs, channels, ytsearch expressions, local
 * paths, and option-like inputs.
 */
export function extractVideoId(rawUrl: string): string {
	let url = rawUrl.trim();
	if (!url) throw youtubeError("Empty URL: provide a YouTube watch/shorts/youtu.be link");
	if (url.startsWith("-")) throw youtubeError("Refusing option-like input");
	if (/^ytsearch\d*:/i.test(url)) throw youtubeError("ytsearch expressions are not supported — pass a single video URL");
	if (!/:\/\//.test(url)) url = `https://${url}`;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw youtubeError(`Not a recognised YouTube video URL: ${rawUrl.slice(0, 80)}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw youtubeError("Only http(s) YouTube URLs are supported");
	}
	if (parsed.username || parsed.password) throw youtubeError("URLs with credentials are not allowed");
	const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
	const isYouTube =
		host === "youtube.com" ||
		host.endsWith(".youtube.com") ||
		host === "youtu.be" ||
		host.endsWith(".youtu.be");
	if (!isYouTube) throw youtubeError(`Not a YouTube URL (host: ${host || "none"})`);

	let id = "";
	const path = parsed.pathname;
	if ((host === "youtu.be" || host.endsWith(".youtu.be")) && /^\/[A-Za-z0-9_-]{11}$/.test(path)) {
		id = path.slice(1);
	} else if (path === "/watch") {
		id = parsed.searchParams.get("v") ?? "";
	} else {
		const m = /^\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/.exec(path);
		if (m) id = m[2];
	}
	if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
		throw youtubeError(
			"Could not find a single-video ID (playlists, channels, and homepages are not supported)",
		);
	}
	return id;
}

export function canonicalWatchUrl(videoId: string): string {
	return `https://www.youtube.com/watch?v=${videoId}`;
}

function normalizeLang(lang: string): string {
	return lang.trim().toLowerCase().replace(/_/g, "-");
}

/** Validate the caller's language preference (strict: no options/paths). */
export function validateLanguage(raw: string | undefined): string {
	const lang = normalizeLang(raw ?? "en");
	if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(lang)) {
		throw youtubeError(`Unsupported language "${(raw ?? "").slice(0, 20)}": use a BCP-47 tag like en or en-US`);
	}
	return lang;
}

function langMatches(key: string, wanted: string): "exact" | "prefix" | null {
	const k = normalizeLang(key);
	const w = normalizeLang(wanted);
	if (k === w) return "exact";
	if (k.startsWith(`${w}-`)) return "prefix";
	if (w.includes("-") && k === w.split("-")[0]) return "prefix";
	return null;
}

function isTranslated(entry: TrackEntry): boolean {
	return !!entry.tlang && normalizeLang(entry.tlang) !== normalizeLang(entry.lang ?? "");
}

/**
 * Choose (language, manual|auto) from a metadata listing. Never picks
 * machine-translated variants unless nothing original exists (disclosed).
 * Returns null when no captions exist at all.
 */
export function selectCaptionTrack(
	meta: Pick<MetaJson, "subtitles" | "automatic_captions" | "language">,
	preferredLang: string,
): (TrackSelection & { requested: string; fallback: string | null }) | null {
	const wanted = normalizeLang(preferredLang);
	const manual = meta.subtitles ?? {};
	const auto = meta.automatic_captions ?? {};
	const manualKeys = Object.keys(manual).filter((k) => (manual[k] ?? []).length > 0);
	const autoKeys = Object.keys(auto).filter((k) => (auto[k] ?? []).length > 0);
	if (manualKeys.length === 0 && autoKeys.length === 0) return null;

	const rankFor = (keys: string[], dict: Record<string, TrackEntry[]>, want: string) => {
		const out: { key: string; strength: number; translated: boolean }[] = [];
		for (const key of keys) {
			const m = langMatches(key, want);
			if (!m) continue;
			const translated = (dict[key] ?? []).every(isTranslated);
			out.push({ key, strength: m === "exact" ? 0 : 1, translated });
		}
		out.sort((a, b) => a.strength - b.strength || Number(a.translated) - Number(b.translated));
		return out;
	};

	const langsToTry = wanted === "en" ? ["en"] : [wanted, "en"];
	for (const want of langsToTry) {
		for (const c of rankFor(manualKeys, manual, want)) {
			if (c.translated) continue;
			return {
				lang: c.key,
				manual: true,
				translated: false,
				requested: wanted,
				fallback: want === wanted ? null : `requested ${wanted}, using English`,
			};
		}
		for (const c of rankFor(autoKeys, auto, want)) {
			if (c.translated) continue;
			return {
				lang: c.key,
				manual: false,
				translated: false,
				requested: wanted,
				fallback: want === wanted ? null : `requested ${wanted}, using English`,
			};
		}
	}
	// Translated-only tracks, disclosed.
	for (const want of langsToTry) {
		for (const c of [...rankFor(manualKeys, manual, want), ...rankFor(autoKeys, auto, want)]) {
			const isManual = manualKeys.includes(c.key);
			return {
				lang: c.key,
				manual: isManual,
				translated: true,
				requested: wanted,
				fallback: `only machine-translated captions available (${c.key})`,
			};
		}
	}
	// Original-language fallback: video language, else first manual, else first auto.
	const orig = meta.language ? normalizeLang(meta.language) : "";
	const origKey =
		manualKeys.find((k) => normalizeLang(k) === orig) ??
		manualKeys[0] ??
		autoKeys.find((k) => normalizeLang(k) === orig) ??
		autoKeys[0];
	if (!origKey) return null;
	return {
		lang: origKey,
		manual: manualKeys.includes(origKey),
		translated: false,
		requested: wanted,
		fallback: `requested ${wanted} unavailable, using original language (${origKey})`,
	};
}

function parseTimestamp(raw: string): number {
	const m = /^(?:(\d+):)?([0-5]?\d):([0-5]\d)[.,](\d{1,3})$/.exec(raw.trim());
	if (!m) throw new Error(`bad timestamp ${raw}`);
	const h = parseInt(m[1] ?? "0", 10);
	const min = parseInt(m[2], 10);
	const sec = parseInt(m[3], 10);
	const ms = parseInt(m[4].padEnd(3, "0"), 10);
	return h * 3600 + min * 60 + sec + ms / 1000;
}

function decodeEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
}

function stripCueTags(text: string): string {
	return decodeEntities(text.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** Parse WebVTT or SRT cue text into timestamped cues. */
export function parseVtt(body: string): Cue[] {
	const normalized = body.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
	const lines = normalized.split("\n");
	let i = 0;
	// Skip header (WEBVTT + header comments) up to the first blank line.
	if (lines[0]?.startsWith("WEBVTT")) {
		while (i < lines.length && lines[i]?.trim() !== "") i++;
	}
	const cues: Cue[] = [];
	while (i < lines.length) {
		while (i < lines.length && lines[i]?.trim() === "") i++;
		if (i >= lines.length) break;
		const line = lines[i++] ?? "";
		if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(line)) {
			while (i < lines.length && lines[i]?.trim() !== "") i++;
			continue;
		}
		// SRT numeric cue identifiers precede the timestamp line.
		let stampLine = line;
		if (!stampLine.includes("-->") && /^\d+$/.test(stampLine.trim())) {
			stampLine = lines[i++] ?? "";
		}
		const arrow = stampLine.indexOf("-->");
		if (arrow < 0) {
			while (i < lines.length && lines[i]?.trim() !== "") i++;
			continue;
		}
		let start: number;
		let end: number;
		try {
			start = parseTimestamp(stampLine.slice(0, arrow).trim().split(/\s+/).pop() ?? "");
			end = parseTimestamp(stampLine.slice(arrow + 3).trim().split(/\s+/).shift() ?? "");
		} catch {
			while (i < lines.length && lines[i]?.trim() !== "") i++;
			continue;
		}
		const textLines: string[] = [];
		while (i < lines.length && lines[i]?.trim() !== "") textLines.push(lines[i++] ?? "");
		const text = stripCueTags(textLines.join(" "));
		if (text) cues.push({ start, end, text });
	}
	if (cues.length === 0) throw new Error("caption file contained no cues");
	return cues;
}

/** Parse YouTube json3 timedtext into cues. */
export function parseJson3(body: string): Cue[] {
	let doc: unknown;
	try {
		doc = JSON.parse(body);
	} catch {
		throw new Error("caption file is not valid json3");
	}
	const events = (doc as { events?: unknown }).events;
	if (!Array.isArray(events)) throw new Error("json3 caption file has no events");
	const cues: Cue[] = [];
	for (const e of events as Record<string, unknown>[]) {
		const segs = e["segs"];
		if (!Array.isArray(segs)) continue;
		const text = stripCueTags(
			segs
				.map((s) => (typeof (s as Record<string, unknown>)["utf8"] === "string" ? ((s as Record<string, unknown>)["utf8"] as string) : ""))
				.join(""),
		);
		if (!text) continue;
		const startMs = typeof e["tStartMs"] === "number" ? (e["tStartMs"] as number) : 0;
		const durMs = typeof e["dDurationMs"] === "number" ? (e["dDurationMs"] as number) : 2000;
		cues.push({ start: startMs / 1000, end: (startMs + durMs) / 1000, text });
	}
	if (cues.length === 0) throw new Error("json3 caption file contained no cues");
	return cues;
}

/**
 * Drop exact consecutive duplicates (rolling-window repeats in automatic
 * captions). Manual captions are kept verbatim so intentional repetition
 * is never deleted.
 */
export function dedupeCues(cues: Cue[], automatic: boolean): Cue[] {
	if (!automatic) return cues;
	const out: Cue[] = [];
	let prev = "";
	for (const cue of cues) {
		const norm = cue.text.toLowerCase().replace(/\s+/g, " ").trim();
		if (norm && norm === prev) continue;
		out.push(cue);
		prev = norm;
	}
	return out;
}

export function formatStamp(totalSeconds: number): string {
	const s = Math.max(0, Math.floor(totalSeconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
	return h > 0 ? `${h}:${mm}:${String(sec).padStart(2, "0")}` : `${mm}:${String(sec).padStart(2, "0")}`;
}

export interface TranscriptResult {
	title: string;
	url: string;
	content: string;
	meta?: { title?: string; author?: string; published?: string };
	videoId: string;
	captionLanguage: string;
	automatic: boolean;
}

export interface YoutubeDeps {
	runMetadata?: (args: string[], opts: { signal?: AbortSignal; cwd: string; env: Record<string, string> }) => Promise<{ stdout: string; stderr: string }>;
	downloadSubs?: (args: string[], opts: { signal?: AbortSignal; cwd: string; env: Record<string, string> }) => Promise<{ stderr: string }>;
	listFiles?: (dir: string) => Promise<string[]>;
	readCaptionFile?: (path: string) => Promise<string>;
}

function minimalEnv(tmpdirPath: string): Record<string, string> {
	const env: Record<string, string> = { HOME: tmpdirPath, XDG_CACHE_HOME: tmpdirPath };
	for (const k of ["PATH", "PATHEXT", "LANG", "LC_ALL", "LC_MESSAGES", "TZ", "SYSTEMROOT", "SYSTEMDRIVE", "TEMP", "TMP"]) {
		const v = process.env[k];
		if (v) env[k] = k === "TEMP" || k === "TMP" ? tmpdirPath : v;
	}
	if (!env["PATH"]) env["PATH"] = "/usr/bin:/bin";
	return env;
}

function defaultRun(args: string[], opts: { signal?: AbortSignal; cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const timeout = AbortSignal.timeout(opts.timeoutMs);
		const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
		const child = execFile("yt-dlp", args, {
			signal,
			timeout: opts.timeoutMs,
			maxBuffer: STDOUT_CAP + STDERR_CAP,
			killSignal: "SIGKILL",
			windowsHide: true,
			cwd: opts.cwd,
			env: opts.env,
		}, (error, stdout, stderr) => {
			const out = (stdout ?? "").slice(0, STDOUT_CAP);
			const err = (stderr ?? "").slice(0, STDERR_CAP);
			if (error) {
				const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
				if (e.code === "ENOENT") {
					reject(youtubeError('yt-dlp not on PATH (optional dependency). Install: pipx install "yt-dlp[default]"'));
					return;
				}
				reject({ killOrExit: true, code: e.code, stdout: out, stderr: err, aborted: opts.signal?.aborted ?? false } as const);
				return;
			}
			resolve({ stdout: out, stderr: err });
		});
		child.on("error", () => undefined);
	});
}

function classifyMetadataFailure(stderr: string): ReaderError {
	const s = stderr.toLowerCase();
	if (/this video is private|login|sign in|cookies/.test(s)) {
		return youtubeError("Video is private or login-gated — no cookie/login bypass is offered. The video owner must make it public.");
	}
	if (/video unavailable|removed|deleted|no video|unsupported url|not available/.test(s)) {
		return youtubeError("Video is unavailable, removed, or the URL is not a video page.");
	}
	if (/bot|challenge|captcha/.test(s)) {
		return youtubeError("YouTube served a bot challenge for this video. Retry later from a residential network; no proxy/auth bypass is attempted.");
	}
	return youtubeError(`yt-dlp could not read this video: ${stderr.slice(0, 200) || "unknown error"}`);
}

function classifyDownloadFailure(stderr: string, lang: string): ReaderError {
	const s = stderr.toLowerCase();
	if (/429|too many requests/.test(s)) {
		return youtubeError(`YouTube rate-limited the caption download (HTTP 429). Wait and retry; no proxy bypass is attempted. Requested language: ${lang}.`);
	}
	if (/\b403\b|forbidden/.test(s)) {
		return youtubeError(`YouTube refused the caption download (HTTP 403). The captions may be region- or session-gated. Requested language: ${lang}.`);
	}
	if (/bot|challenge|captcha/.test(s)) {
		return youtubeError("YouTube served a bot challenge for the caption download. Retry later; no bypass is attempted.");
	}
	if (/private|login|sign in/.test(s)) {
		return youtubeError("Captions need login (private/members video) — no cookie bypass is offered.");
	}
	return youtubeError(`Caption download failed: ${stderr.slice(0, 200) || "unknown error"}`);
}

/**
 * Fetch a video transcript. All failures are terminal (no generic fallback)
 * so callers never mistake watch-page text for captions.
 */
export async function fetchYoutubeTranscript(
	rawUrl: string,
	opts: { language?: string; signal?: AbortSignal } = {},
	deps: YoutubeDeps = {},
): Promise<TranscriptResult> {
	const videoId = extractVideoId(rawUrl);
	const language = validateLanguage(opts.language);
	const watchUrl = canonicalWatchUrl(videoId);
	const signal = opts.signal;
	signal?.throwIfAborted();

	const tmp = await mkdtemp(join(tmpdir(), "pi-yt-"));
 const cleanup = () => rm(tmp, { recursive: true, force: true });
	try {
		const denoPath = whichSync("deno");
		const nodePath = whichSync("node");
		const jsArgs =
			denoPath ? ["--js-runtimes", `deno:${denoPath}`]
			: nodePath ? ["--js-runtimes", `node:${nodePath}`]
			: [];
		const env = minimalEnv(tmp);
		const runMeta =
			deps.runMetadata ??
			((args, o) => defaultRun(args, { ...o, timeoutMs: METADATA_TIMEOUT_MS }));
		const dlSubs =
			deps.downloadSubs ??
			(async (args, o) => {
				const r = await defaultRun(args, { ...o, timeoutMs: DOWNLOAD_TIMEOUT_MS });
				return { stderr: r.stderr };
			});

		let meta: MetaJson;
		try {
			const { stdout } = await runMeta(
				["--ignore-config", "--no-update", "--no-plugin-dirs", "--no-remote-components", "--no-playlist", "--skip-download", "--dump-single-json", ...jsArgs, watchUrl],
				{ signal, cwd: tmp, env },
			);
			try {
				meta = JSON.parse(stdout) as MetaJson;
			} catch {
				throw youtubeError("yt-dlp returned unparseable metadata.");
			}
		} catch (err) {
			if (err instanceof ReaderError) throw err;
			const r = err as { killOrExit?: boolean; code?: unknown; stdout?: string; stderr?: string; aborted?: boolean };
			if (r && r.killOrExit) {
				if (r.aborted || signal?.aborted) throw new Error(`YouTube read cancelled for ${watchUrl}`);
				if (typeof r.code === "string" && (r.code === "ETIMEDOUT" || String(r.code).includes("TIMEOUT"))) {
					throw youtubeError("yt-dlp timed out reading video metadata (30s). The video page may be slow or gated.");
				}
				throw classifyMetadataFailure(r.stderr ?? "");
			}
			throw err;
		}

		const selection = selectCaptionTrack(meta, language);
		if (!selection) {
			throw youtubeError(
				`No captions available for this video (neither manual nor automatic). Try web_read without a reader for the watch page text. Title: ${meta.title ?? "unknown"}`,
			);
		}
		signal?.throwIfAborted();

		const flag = selection.manual ? "--write-sub" : "--write-auto-sub";
		try {
			await dlSubs(
				["--ignore-config", "--no-update", "--no-plugin-dirs", "--no-remote-components", "--no-playlist", "--skip-download", flag, "--sub-langs", selection.lang, "--sub-format", "vtt/json3/srt/best", ...jsArgs, "-o", `${tmp}/%(id)s.%(ext)s`, watchUrl],
				{ signal, cwd: tmp, env },
			);
		} catch (err) {
			if (err instanceof ReaderError) throw err;
			const r = err as { killOrExit?: boolean; code?: unknown; stderr?: string; aborted?: boolean };
			if (r && r.killOrExit) {
				if (r.aborted || signal?.aborted) throw new Error(`YouTube read cancelled for ${watchUrl}`);
				throw classifyDownloadFailure(r.stderr ?? "", selection.lang);
			}
			throw err;
		}
		signal?.throwIfAborted();

		const listFiles = deps.listFiles ?? readdir;
	 const readCaptionFile = deps.readCaptionFile ?? ((p: string) => readFile(p, "utf-8"));
		const files = (await listFiles(tmp)).filter((f) =>
			new RegExp(`^${videoId}\\.[A-Za-z-]+\\.(vtt|json3|srt)$`).test(f),
		);
		if (files.length === 0) {
			throw youtubeError(
				`Caption download produced no parseable subtitle file (requested ${selection.lang}). The track may have vanished or only unsupported formats exist.`,
			);
		}
		files.sort((a, b) => {
			const rank = (f: string) => PARSEABLE_EXTS.indexOf(f.split(".").pop() as (typeof PARSEABLE_EXTS)[number]);
			return rank(a) - rank(b);
		});
	 const chosen = files[0] as string;
		const ext = chosen.split(".").pop() as string;
		let raw = await readCaptionFile(join(tmp, chosen));
		if (raw.length > FILE_CAP) {
			throw youtubeError(`Caption file too large (${raw.length} bytes, limit ${FILE_CAP}).`);
		}
		if (signal?.aborted) throw new Error(`YouTube read cancelled for ${watchUrl}`);

		let cues = ext === "json3" ? parseJson3(raw) : parseVtt(raw);
		cues = dedupeCues(cues, !selection.manual);
		if (cues.length === 0) throw youtubeError("Caption file contained no usable cues.");

	 const kind = selection.manual ? "manual" : "automatic";
		const transNote = selection.translated ? `, translated to ${selection.lang}` : "";
		const head =
			`# ${meta.title ?? videoId}\n\n` +
			`*Source: ${watchUrl} · captions: ${kind}${transNote} · language ${selection.lang} (requested ${selection.requested})` +
			(selection.fallback ? ` · ${selection.fallback}` : "") +
			` · ${cues.length} cues*\n` +
			(meta.channel || meta.duration_string || meta.upload_date
				? `\n${[meta.channel && `Channel: ${meta.channel}`, meta.duration_string && `Duration: ${meta.duration_string}`, meta.upload_date && `Uploaded: ${meta.upload_date}`].filter(Boolean).join(" · ")}\n`
				: "\n");
		const body = cues.map((c) => `[${formatStamp(c.start)}] ${c.text}`).join("\n");
		const content = `${head}\n${body}`;
		return {
			title: meta.title ?? videoId,
			url: watchUrl,
			content,
			meta: {
				title: meta.title,
				author: meta.channel,
				published: meta.upload_date,
			},
			videoId,
			captionLanguage: selection.lang,
			automatic: !selection.manual,
		};
	} finally {
		await cleanup();
	}
}
