/**
 * RSS/Atom reader — keyless, fully local feed → Markdown conversion.
 *
 * Explicit source reader for `web_read(url, reader: "rss")`. Fetches through
 * the bounded public-HTTP helper (redirect re-validation, streaming byte
 * cap), then parses locally with fast-xml-parser. The parser never fetches;
 * DTD/entity declarations are rejected before parsing (XXE/billion-laughs).
 * Embedded entry HTML is converted to text locally and never executed
 * or fetched. Supports RSS 2.0 and Atom; HTML login/error pages are not
 * feeds and throw. Entry coverage is capped at 50 and declared honestly.
 */
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parseHTML } from "linkedom";
import { fetchWithRedirectValidation, readBoundedText, readErrorSnippet } from "../http.js";
import { timeoutSignal, sanitizeError } from "../utils.js";
import { targetBlockedError } from "../readers/errors.js";

/** Cap on a fetched feed body — feeds run larger than articles. */
const FEED_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
/** Maximum entries rendered; the cap is declared in the output. */
export const RSS_MAX_ENTRIES = 50;
/** Per-entry excerpt length after HTML stripping. */
const EXCERPT_CHARS = 1000;

export interface RssFetchResult {
	title: string;
	url: string;
	content: string;
	entryCount: number;
	capped: boolean;
}

interface FeedEntry {
	title?: string;
	url?: string;
	author?: string;
	date?: string;
	body?: string;
}

function asArray<T>(v: T | T[] | undefined): T[] {
	if (v === undefined || v === null) return [];
	return Array.isArray(v) ? v : [v];
}

function firstString(...candidates: unknown[]): string {
	for (const c of candidates) {
		if (typeof c === "string" && c.trim()) return c.trim();
		if (c !== null && typeof c === "object") {
			const o = c as Record<string, unknown>;
			// fast-xml-parser text nodes: { "#text": "..." } or { "@_href": ... }
			if (typeof o["#text"] === "string" && (o["#text"] as string).trim())
				return (o["#text"] as string).trim();
			if (typeof o["__cdata"] === "string" && (o["__cdata"] as string).trim())
				return (o["__cdata"] as string).trim();
		}
	}
	return "";
}

/** Convert embedded entry HTML to plain text locally — never fetched. */
function stripHtml(html: string): string {
	if (!html.includes("<")) return html;
	try {
		const { document } = parseHTML(`<div>${html}</div>`);
		const text = document.querySelector("div")?.textContent ?? html;
		return text.replace(/\s+/g, " ").trim();
	} catch {
		return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
	}
}

function excerpt(body: string): string {
	const clean = stripHtml(body).trim();
	if (clean.length <= EXCERPT_CHARS) return clean;
	return clean.slice(0, EXCERPT_CHARS).trimEnd() + "…";
}

function resolveLink(href: string, base: string): string {
	if (!href) return "";
	try {
		return new URL(href, base).toString();
	} catch {
		return href;
	}
}

function entryMarkdown(index: number, entry: FeedEntry): string {
	const lines: string[] = [`## ${index + 1}. ${entry.title || "(untitled)"}`];
	if (entry.url) lines.push(`- URL: ${entry.url}`);
	const byline = [entry.author, entry.date].filter(Boolean).join(" · ");
	if (byline) lines.push(`- ${byline}`);
	const body = excerpt(entry.body ?? "");
	lines.push("", body || "(no content)");
	return lines.join("\n");
}

/**
 * Parse feed XML into readable Markdown. Pure function — no I/O, fully
 * deterministic for fixtures. Throws when the body is not a supported feed.
 */
export function parseFeedToMarkdown(xml: string, baseUrl: string): RssFetchResult {
	// HTML login/error pages are the common non-feed body — identify first so
	// they are reported as HTML, not as a generic DTD rejection.
	if (/<html[\s>]/i.test(xml.slice(0, 4096)) || /<!doctype html/i.test(xml.slice(0, 4096))) {
		throw new Error("Not a feed: URL returned an HTML page (login/error pages are not feeds)");
	}
	if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
		throw new Error("Feed rejected: DTD/entity declarations are not allowed");
	}
	const validation = XMLValidator.validate(xml);
	if (validation !== true) {
		if (/<html[\s>]/i.test(xml.slice(0, 4096)) || /<!doctype html/i.test(xml.slice(0, 4096))) {
			throw new Error("Not a feed: URL returned an HTML page (login/error pages are not feeds)");
		}
		throw new Error("Not a feed: response is not parseable feed XML");
	}

	const parser = new XMLParser({
		ignoreAttributes: false,
		attributeNamePrefix: "@_",
		trimValues: true,
		parseTagValue: false,
	});
	const doc = parser.parse(xml) as Record<string, unknown>;

	let feedTitle = "";
	let feedDescription = "";
	let entries: FeedEntry[] = [];

	const rss = doc["rss"] as Record<string, unknown> | undefined;
	const rdf = doc["rdf:RDF"] as Record<string, unknown> | undefined;
	const atom = doc["feed"] as Record<string, unknown> | undefined;

	if (rss && typeof rss["channel"] === "object") {
		const channel = rss["channel"] as Record<string, unknown>;
		feedTitle = firstString(channel["title"]);
		feedDescription = stripHtml(firstString(channel["description"], channel["subtitle"]));
		const base = firstString(channel["link"]) || baseUrl;
		for (const item of asArray(channel["item"] as Record<string, unknown>[])) {
			const link = firstString(item["link"], (item["guid"] as Record<string, unknown> | undefined)?.["#text"], item["guid"]);
			entries.push({
				title: firstString(item["title"]),
				url: resolveLink(link, link.startsWith("http") ? link : base || baseUrl),
				author: firstString(item["author"], item["dc:creator"], (item["creator"] as string | undefined)),
				date: firstString(item["pubDate"], item["updated"], item["published"]),
				body: firstString(item["content:encoded"], item["content"], item["description"], item["summary"]),
			});
		}
	} else if (rdf && (rdf["channel"] || rdf["item"])) {
		const channel = (asArray(rdf["channel"] as Record<string, unknown>[])[0] ?? {}) as Record<string, unknown>;
		feedTitle = firstString(channel["title"]);
		feedDescription = stripHtml(firstString(channel["description"]));
		const base = firstString(channel["link"]) || baseUrl;
		for (const item of asArray(rdf["item"] as Record<string, unknown>[])) {
			const link = firstString(item["link"]);
			entries.push({
				title: firstString(item["title"]),
				url: resolveLink(link, baseUrl || base),
				author: firstString(item["dc:creator"], item["author"]),
				date: firstString(item["dc:date"], item["pubDate"]),
				body: firstString(item["content:encoded"], item["description"], item["content"]),
			});
		}
	} else if (atom && (atom["entry"] !== undefined || atom["title"] !== undefined)) {
		feedTitle = firstString(atom["title"]);
		feedDescription = stripHtml(firstString(atom["subtitle"], atom["tagline"]));
		for (const e of asArray(atom["entry"] as Record<string, unknown>[])) {
			const linkNode = asArray(e["link"] as Record<string, unknown>[]).find(
				(l) => !l["@_rel"] || l["@_rel"] === "alternate",
			) ?? asArray(e["link"] as Record<string, unknown>[])[0];
			const href = typeof linkNode?.["@_href"] === "string" ? (linkNode["@_href"] as string) : firstString(e["id"]);
			const authorNode = e["author"] as Record<string, unknown> | undefined;
			entries.push({
				title: firstString(e["title"]),
				url: resolveLink(href, baseUrl),
				author: firstString(authorNode?.["name"], e["author"]),
				date: firstString(e["updated"], e["published"]),
				body: firstString(
					(e["content"] as Record<string, unknown> | undefined)?.["#text"],
					e["content"],
					e["summary"],
				),
			});
		}
	} else {
		throw new Error("Not a feed: no RSS channel, RDF items, or Atom feed found");
	}

	const total = entries.length;
	const capped = total > RSS_MAX_ENTRIES;
	const shown = capped ? entries.slice(0, RSS_MAX_ENTRIES) : entries;
	const lines: string[] = [`# ${feedTitle || "(untitled feed)"}`, ""];
	if (feedDescription) {
		lines.push(feedDescription.length > EXCERPT_CHARS ? feedDescription.slice(0, EXCERPT_CHARS).trimEnd() + "…" : feedDescription, "");
	}
	if (total === 0) {
		lines.push("Feed is empty (0 entries).", "", `*Source: ${baseUrl}*`);
		return { title: feedTitle, url: baseUrl, content: lines.join("\n"), entryCount: 0, capped: false };
	}
	lines.push(
		capped
			? `*Source: ${baseUrl} · ${total} entries (showing first ${RSS_MAX_ENTRIES})*`
			: `*Source: ${baseUrl} · ${total} ${total === 1 ? "entry" : "entries"}*`,
		"",
	);
	shown.forEach((entry, i) => {
		lines.push(entryMarkdown(i, entry), "");
	});
	return {
		title: feedTitle,
		url: baseUrl,
		content: lines.join("\n").trimEnd(),
		entryCount: total,
		capped,
	};
}

/**
 * Fetch a feed URL and convert it to Markdown. Throws on transport errors
 * and non-feed bodies so the reader chain can try the next reader.
 */
export async function fetchRssFeed(
	url: string,
	signal?: AbortSignal,
): Promise<{ title: string; url: string; content: string; meta?: { title?: string } }> {
	const { response, finalUrl } = await fetchWithRedirectValidation(
		url,
		{
			signal: timeoutSignal(signal),
			headers: {
				Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
				"Accept-Language": "en",
				"User-Agent": "pi-search-hub/reader (local RSS extraction)",
			},
		},
		3,
	);
	if (!response.ok) {
		const snippet = await readErrorSnippet(response);
		const msg = `Failed to read ${url}: ${sanitizeError(response.status, snippet)}`;
		if (response.status === 401 || response.status === 403)
			throw targetBlockedError("rss", response.status, msg);
		throw new Error(msg);
	}
	const contentLength = parseInt(response.headers.get("content-length") ?? "", 10);
	if (Number.isFinite(contentLength) && contentLength > FEED_MAX_BYTES) {
		throw new Error(`Failed to read ${url}: response too large (${contentLength} bytes, limit ${FEED_MAX_BYTES})`);
	}
	const xml = await readBoundedText(response, FEED_MAX_BYTES, url);
	if (signal?.aborted) throw new Error(`RSS read cancelled for ${url}`);
	const parsed = parseFeedToMarkdown(xml, finalUrl);
	return {
		title: parsed.title,
		url: parsed.url,
		content: parsed.content,
		meta: parsed.title ? { title: parsed.title } : undefined,
	};
}
