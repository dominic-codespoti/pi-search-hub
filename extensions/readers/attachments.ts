/**
 * Attachment discovery — inventory file links in reader Markdown output.
 *
 * Runs on already-extracted text (zero extra fetches) for every reader.
 * Matches the formats @firecrawl/anydoc converts so each reported URL is
 * directly readable with `reader: "anydoc"`.
 */

export interface AttachmentLink {
	url: string;
	text?: string;
}

/** File extensions Anydoc converts (mirrors its supported format list). */
const ATTACHMENT_EXTENSIONS = new Set([
	"pdf",
	"doc", "docx", "docm",
	"ppt", "pps", "pot", "pptx", "pptm", "ppsx", "ppsm",
	"xls", "xlsx", "xlsm", "xlsb",
	"odt", "ods", "odp",
	"rtf", "epub", "csv",
]);

const MAX_ATTACHMENTS = 50;

const MARKDOWN_LINK = /\[([^\]]{0,200})\]\((\S+?)(?:\s+"[^"]*")?\)/g;

/**
 * Find attachment links in Markdown, resolved against the page URL.
 * Deduped, capped, extension-matched on the URL path (query/fragment ignored).
 */
export function findAttachments(markdown: string, baseUrl: string): AttachmentLink[] {
	const found: AttachmentLink[] = [];
	const seen = new Set<string>();
	let match: RegExpExecArray | null;
	MARKDOWN_LINK.lastIndex = 0;
	while ((match = MARKDOWN_LINK.exec(markdown)) !== null) {
		if (found.length >= MAX_ATTACHMENTS) break;
		let absolute: string;
		try {
			absolute = new URL(match[2], baseUrl).href;
		} catch {
			continue;
		}
		if (!absolute.startsWith("https://") && !absolute.startsWith("http://")) continue;
		let path: string;
		try {
			path = new URL(absolute).pathname.toLowerCase();
		} catch {
			continue;
		}
		const dot = path.lastIndexOf(".");
		if (dot < 0 || !ATTACHMENT_EXTENSIONS.has(path.substring(dot + 1))) continue;
		if (seen.has(absolute)) continue;
		seen.add(absolute);
		const text = match[1].trim();
		found.push(text ? { url: absolute, text } : { url: absolute });
	}
	return found;
}
