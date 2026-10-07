/**
 * Tests for the YouTube captions reader — pure helpers with fixtures plus
 * transcript assembly with injected subprocess fakes (no yt-dlp spawned).
 */
import { describe, it, expect } from "vitest";
import {
	extractVideoId,
	validateLanguage,
	selectCaptionTrack,
	parseVtt,
	parseJson3,
	dedupeCues,
	formatStamp,
	fetchYoutubeTranscript,
} from "./youtube.js";
import { ReaderError } from "../readers/errors.js";

const META_BOTH = {
	title: "Demo",
	channel: "Chan",
	duration_string: "1:00",
	upload_date: "20260101",
	subtitles: { en: [{ ext: "vtt", url: "https://example.com/a" }] },
	automatic_captions: {
		en: [{ ext: "vtt", url: "https://example.com/b" }],
		es: [{ ext: "vtt", url: "https://example.com/c" }],
	},
};

const META_AUTO_TRANSLATED = {
	title: "Gangnam",
	subtitles: {},
	automatic_captions: {
		ko: [{ ext: "vtt", url: "https://example.com/ko" }],
		ab: [{ ext: "json3", url: "https://example.com/ab", tlang: "ab", lang: "ko" }],
	},
};

const VTT = `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.000 align:start position:0%
Hello <c>world</c> &amp; friends

00:00:02.000 --> 00:00:04.000
Hello world &amp; friends

00:00:04.000 --> 00:00:06.000
Brand new line

NOTE a comment

00:00:06.000 --> 00:00:08.000
Final <b>line</b>
`;

const JSON3 = JSON.stringify({
	events: [
		{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "hello " }, { utf8: "world" }] },
		{ tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: "second" }] },
		{ tStartMs: 4000, segs: [{ utf8: "" }] },
	],
});

describe("extractVideoId", () => {
	it.each([
		["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
		["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s&list=PLx", "dQw4w9WgXcQ"],
		["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
		["youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
		["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
		["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
		["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
	])("accepts %s", (url, id) => {
		expect(extractVideoId(url)).toBe(id);
	});

	it.each([
		"https://www.youtube.com/playlist?list=PLx",
		"https://www.youtube.com/@somechannel",
		"https://www.youtube.com/channel/UCx",
		"https://www.youtube.com/",
		"https://example.com/watch?v=dQw4w9WgXcQ",
		"https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
		"https://youtube.com@evil.test/",
		"ytsearch5:cats",
		"--write-sub",
		"/tmp/audio.mp3",
		"https://www.youtube.com/watch?v=short",
	])("rejects %s", (url) => {
		expect(() => extractVideoId(url)).toThrow(ReaderError);
	});
});

describe("validateLanguage", () => {
	it("defaults to en and normalizes", () => {
		expect(validateLanguage(undefined)).toBe("en");
		expect(validateLanguage("EN_us")).toBe("en-us");
	});
	it("rejects option-like and path-like input", () => {
		expect(() => validateLanguage("--write-sub")).toThrow(ReaderError);
		expect(() => validateLanguage("../../etc")).toThrow(ReaderError);
		expect(() => validateLanguage("e")).toThrow(ReaderError);
	});
});

describe("selectCaptionTrack", () => {
	it("prefers manual over automatic in the requested language", () => {
		const s = selectCaptionTrack(META_BOTH, "en")!;
		expect(s).toMatchObject({ lang: "en", manual: true, translated: false, fallback: null });
	});

	it("uses English fallback with disclosure", () => {
		const s = selectCaptionTrack(META_BOTH, "fr")!;
		expect(s.manual).toBe(true);
		expect(s.fallback).toMatch(/English/);
	});

	it("deprioritizes machine-translated variants", () => {
		const s = selectCaptionTrack(META_AUTO_TRANSLATED, "ab")!;
		// ab exists but every entry is translated; ko original wins via prefix? No:
		// ab exact translated loses to nothing original in ab, so translated ab is returned disclosed.
		expect(s.translated).toBe(true);
		expect(s.fallback).toMatch(/translated/);
	});

	it("falls back to the original language with disclosure", () => {
		const s = selectCaptionTrack(META_AUTO_TRANSLATED, "fr")!;
		expect(s.lang).toBe("ko");
		expect(s.fallback).toMatch(/original language/);
	});

	it("returns null when no captions exist", () => {
		expect(selectCaptionTrack({ subtitles: {}, automatic_captions: {} }, "en")).toBeNull();
	});
});

describe("parseVtt", () => {
	it("parses cues, strips tags, decodes entities, skips NOTE", () => {
		const cues = parseVtt(VTT);
		expect(cues).toHaveLength(4);
		expect(cues[0]).toMatchObject({ start: 0, end: 2, text: "Hello world & friends" });
		expect(cues[3]?.text).toBe("Final line");
	});

	it("throws on cueless input", () => {
		expect(() => parseVtt("WEBVTT\n\n")).toThrow(/no cues/);
	});
});

describe("parseJson3", () => {
	it("joins segs and converts times", () => {
		const cues = parseJson3(JSON3);
		expect(cues).toHaveLength(2);
		expect(cues[0]).toMatchObject({ start: 0, end: 2, text: "hello world" });
	});

	it("throws on invalid json", () => {
		expect(() => parseJson3("not json")).toThrow(/json3/);
	});
});

describe("dedupeCues", () => {
	const cues = [
		{ start: 0, end: 2, text: "Hello world" },
		{ start: 2, end: 4, text: "hello  world" },
		{ start: 4, end: 6, text: "New line" },
	];
	it("drops exact consecutive duplicates for automatic captions", () => {
		expect(dedupeCues(cues, true)).toHaveLength(2);
	});
	it("keeps everything for manual captions", () => {
		expect(dedupeCues(cues, false)).toHaveLength(3);
	});
});

describe("formatStamp", () => {
	it("formats mm:ss and h:mm:ss", () => {
		expect(formatStamp(0)).toBe("0:00");
		expect(formatStamp(65)).toBe("1:05");
		expect(formatStamp(3723)).toBe("1:02:03");
	});
});

describe("fetchYoutubeTranscript", () => {
	const URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

	function fakeDeps(meta: unknown, files: Record<string, string>) {
		return {
			runMetadata: async () => ({ stdout: JSON.stringify(meta), stderr: "" }),
			downloadSubs: async () => ({ stderr: "" }),
			listFiles: async () => Object.keys(files),
			readCaptionFile: async (p: string) => {
				const name = p.split("/").pop()!;
				const body = files[name];
				if (body === undefined) throw new Error("missing file");
				return body;
			},
		};
	}

	it("assembles markdown with provenance from manual tracks", async () => {
		const r = await fetchYoutubeTranscript(
			URL,
			{ language: "en" },
			fakeDeps(META_BOTH, { "dQw4w9WgXcQ.en.vtt": VTT }),
		);
		expect(r.videoId).toBe("dQw4w9WgXcQ");
		expect(r.automatic).toBe(false);
		expect(r.captionLanguage).toBe("en");
		expect(r.content).toContain("# Demo");
		expect(r.content).toContain("captions: manual");
		expect(r.content).toContain("[0:00] Hello world & friends");
		expect(r.meta).toMatchObject({ title: "Demo", author: "Chan" });
		expect(r.content).not.toContain("expire=");
	});

	it("dedupes automatic rolling repeats", async () => {
		const r = await fetchYoutubeTranscript(
			URL,
			{ language: "es" },
			fakeDeps(META_BOTH, { "dQw4w9WgXcQ.es.vtt": VTT }),
		);
		expect(r.automatic).toBe(true);
		expect(r.content).toContain("captions: automatic");
		// duplicate second cue removed
		expect(r.content.match(/Hello world & friends/g)).toHaveLength(1);
	});

	it("fails terminally when no captions exist", async () => {
		const err = await fetchYoutubeTranscript(URL, {}, fakeDeps({ title: "X", subtitles: {}, automatic_captions: {} }, {})).catch((e) => e);
		expect(err).toBeInstanceOf(ReaderError);
		expect(err.retryable).toBe(false);
		expect(err.message).toMatch(/No captions/);
	});

	it("fails terminally on empty download output", async () => {
		const err = await fetchYoutubeTranscript(URL, {}, fakeDeps(META_BOTH, {})).catch((e) => e);
		expect(err).toBeInstanceOf(ReaderError);
		expect(err.retryable).toBe(false);
	});
});
