/**
 * Tests for the RSS/Atom reader — deterministic fixtures, no network
 * except stubbed fetch for the transport layer.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { parseFeedToMarkdown, RSS_MAX_ENTRIES } from "./rss.js";

const RSS_BASIC = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<title>Example Blog</title>
<link>https://example.com/blog</link>
<description>Posts about things</description>
<item>
<title>First post</title>
<link>/blog/first</link>
<pubDate>Mon, 06 Oct 2026 10:00:00 GMT</pubDate>
<dc:creator>Ada</dc:creator>
<description><![CDATA[<p>Hello <b>world</b> &amp; friends</p>]]></description>
</item>
<item>
<title>Second post</title>
<link>https://example.com/blog/second</link>
<description>Plain text summary</description>
</item>
</channel>
</rss>`;

const ATOM_BASIC = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom Feed</title>
<subtitle>Testing</subtitle>
<entry>
<title>Entry one</title>
<link href="/posts/1"/>
<id>urn:1</id>
<updated>2026-10-06T10:00:00Z</updated>
<author><name>Bob</name></author>
<summary>Summary <i>text</i></summary>
</entry>
</feed>`;

const EMPTY_RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title><link>https://example.com/</link></channel></rss>`;

const ENTITY_ATTACK = `<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]>
<rss version="2.0"><channel><title>x</title><item><title>&lol2;</title></item></channel></rss>`;

const HTML_LOGIN = `<!DOCTYPE html><html><head><title>Login</title></head><body><form>Sign in</form></body></html>`;

function bigFeed(n: number): string {
	const items = Array.from(
		{ length: n },
		(_, i) => `<item><title>Post ${i}</title><link>https://example.com/${i}</link><description>Body ${i}</description></item>`,
	).join("");
	return `<?xml version="1.0"?><rss version="2.0"><channel><title>Big</title><link>https://example.com/</link>${items}</channel></rss>`;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("parseFeedToMarkdown", () => {
	it("parses RSS 2.0 with CDATA, relative links, author/date", () => {
		const r = parseFeedToMarkdown(RSS_BASIC, "https://example.com/feed.xml");
		expect(r.title).toBe("Example Blog");
		expect(r.entryCount).toBe(2);
		expect(r.capped).toBe(false);
		expect(r.content).toContain("# Example Blog");
		expect(r.content).toContain("## 1. First post");
		expect(r.content).toContain("https://example.com/blog/first");
		expect(r.content).toContain("Ada");
		expect(r.content).toContain("Hello world & friends");
		expect(r.content).not.toContain("<b>");
		expect(r.content).toContain("*Source: https://example.com/feed.xml · 2 entries*");
	});

	it("parses Atom entries with href links and author/date", () => {
		const r = parseFeedToMarkdown(ATOM_BASIC, "https://example.com/atom.xml");
		expect(r.title).toBe("Atom Feed");
		expect(r.entryCount).toBe(1);
		expect(r.content).toContain("## 1. Entry one");
		expect(r.content).toContain("https://example.com/posts/1");
		expect(r.content).toContain("Bob");
		expect(r.content).toContain("2026-10-06");
	});

	it("labels empty feeds instead of failing", () => {
		const r = parseFeedToMarkdown(EMPTY_RSS, "https://example.com/feed");
		expect(r.entryCount).toBe(0);
		expect(r.content).toContain("Feed is empty (0 entries)");
	});

	it("rejects DTD/entity declarations", () => {
		expect(() => parseFeedToMarkdown(ENTITY_ATTACK, "https://example.com/")).toThrow(/DTD\/entity/);
	});

	it("rejects HTML login pages", () => {
		expect(() => parseFeedToMarkdown(HTML_LOGIN, "https://example.com/")).toThrow(/HTML page/);
	});

	it("rejects malformed XML", () => {
		expect(() => parseFeedToMarkdown("<rss><channel><title>oops", "https://example.com/")).toThrow(
			/Not a feed/,
		);
	});

	it("caps huge feeds at 50 with an honest note", () => {
		const r = parseFeedToMarkdown(bigFeed(63), "https://example.com/big.xml");
		expect(r.entryCount).toBe(63);
		expect(r.capped).toBe(true);
		expect(r.content).toContain("showing first 50");
		expect(r.content).toContain("## 50. Post 49");
		expect(r.content).not.toContain("## 51.");
		expect(RSS_MAX_ENTRIES).toBe(50);
	});

	it("keeps short feeds intact (no thin-content concern at parse level)", () => {
		const r = parseFeedToMarkdown(EMPTY_RSS, "https://example.com/feed");
		expect(r.content.trim().length).toBeGreaterThan(0);
	});
});

describe("fetchRssFeed transport", () => {
	it("resolves relative feed URLs against the final URL", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(RSS_BASIC, { status: 200 })),
		);
		const { fetchRssFeed } = await import("./rss.js");
		const r = await fetchRssFeed("https://example.com/feed.xml");
		expect(r.url).toBe("https://example.com/feed.xml");
		expect(r.content).toContain("https://example.com/blog/first");
	});

	it("throws a not-a-feed error for HTML bodies", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(HTML_LOGIN, { status: 200 })));
		const { fetchRssFeed } = await import("./rss.js");
		await expect(fetchRssFeed("https://example.com/")).rejects.toThrow(/HTML page/);
	});
});
