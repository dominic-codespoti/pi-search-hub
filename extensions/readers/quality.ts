/**
 * Challenge-page detection for web_read — high-confidence anti-bot signatures.
 *
 * Ported from agent-reach `channels/web.py::_is_antibot_page` (MIT, revision
 * a19a171). Inspects only the leading response bytes so a genuine article that
 * merely mentions Cloudflare/CAPTCHA is never mistaken for a challenge page.
 */

const SCAN_CHARS = 4096;

const JINA_CAPTCHA_WARNING = "warning:";
const JINA_CAPTCHA_NEED = "requiring captcha";

const CHALLENGE_MARKERS = [
	"title: just a moment...",
	"## performing security verification",
	"title: attention required! | cloudflare",
];

const CLOUDFLARE_TITLE = "title: attention required! | cloudflare";

/**
 * Return true when `content` looks like a provider/target challenge page
 * rather than the requested document. Case-insensitive, leading slice only.
 */
export function isChallengeContent(content: string): boolean {
	const sample = content.slice(0, SCAN_CHARS).toLowerCase();
	if (!sample) return false;

	const jinaCaptchaWarning =
		sample.includes(JINA_CAPTCHA_WARNING) && sample.includes(JINA_CAPTCHA_NEED);
	const challengeStructure = CHALLENGE_MARKERS.some((m) => sample.includes(m));
	const cloudflareBlock =
		sample.includes(CLOUDFLARE_TITLE) &&
		(sample.includes("ray id") || sample.includes("/cdn-cgi/challenge-platform/"));

	return (jinaCaptchaWarning && challengeStructure) || cloudflareBlock;
}
