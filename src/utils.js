// Shared pure helpers. Kept free of network/browser/file dependencies so
// they can be unit-tested without loading the newswire module.
const log = require('./logger');

const DEFAULT_DISCORD_AVATAR_URL = "https://yt3.googleusercontent.com/-jCZaDR8AoEgC6CBPWFubF2PMSOTGU3nJ4VOSo7aq3W6mR8tcRCgygd8fS-4Ra41oHPo3F3P=s900-c-k-c0x00ffffff-no-rj";

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Formats a date for the Discord embed footer. Supported formats:
// "DD/MM/YYYY" (default) and "MM/DD/YYYY". Falls back to ISO on invalid dates.
function formatDate(date, format) {
    const dateObj = new Date(date);
    if (isNaN(dateObj.getTime())) return String(date);

    const day = String(dateObj.getDate()).padStart(2, '0');
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const year = dateObj.getFullYear();

    if (format === 'MM/DD/YYYY') return `${month}/${day}/${year}`;
    if (format === 'DD/MM/YYYY') return `${day}/${month}/${year}`;
    log.error(`[ERROR] Unsupported dateFormat "${format}", falling back to DD/MM/YYYY`);
    return `${day}/${month}/${year}`;
}

// Validates an HTTP request path against the exact shape of served feed files
// ("/feed-<genre>.xml") and returns the local filename, or null if the path
// does not match. Prevents path traversal like /feed-../secret.xml.
function sanitizeFeedFilename(urlPath) {
    const match = /^\/(feed-[a-z0-9-]+\.xml)$/i.exec(urlPath || '');
    return match ? match[1] : null;
}

const DISCORD_WEBHOOK_URL_PATTERN = /^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//;

function isValidDiscordWebhookUrl(url) {
    return typeof url === 'string' && DISCORD_WEBHOOK_URL_PATTERN.test(url);
}

// Converts a Rockstar Tina CMS article tree into RSS-safe HTML content.
// Pure: takes the post payload, returns an HTML string.

function parseContent(post) {
    if (!post.tina || !post.tina.payload || !post.tina.payload.content) return post.title;

    const imgBase = "https://media-rockstargames-com.akamaized.net";
    let autoHtml = "";

    // Add Subtitle (escaped: CMS text interpolated into HTML)
    const subtitle = post.subtitle || (post.tina.payload.meta && post.tina.payload.meta.subtitle);
    if (subtitle) {
        autoHtml += `<h3><strong>${escapeHtml(subtitle)}</strong></h3><br/>`;
    }

    const traverse = (node) => {
        if (!node) return "";

        if (Array.isArray(node)) {
            return node.map(traverse).join("");
        }

        if (typeof node === 'object') {
            let sectionHtml = "";

            // Handle EventInfo / FeaturedEventInfo (Sections with optional Images and Titles)
            if (['EventInfo', 'FeaturedEventInfo'].includes(node._template)) {
                // 1. Images
                if (node.images && Array.isArray(node.images)) {
                    node.images.forEach(imgEntry => {
                        if (imgEntry.image && imgEntry.image.sources) {
                            let src = "";
                            if (imgEntry.image.sources.en_us) {
                                src = imgEntry.image.sources.en_us.desktop || imgEntry.image.sources.en_us.mobile;
                            }
                            if (src) {
                                if (src.startsWith('/')) src = imgBase + src;
                                const alt = imgEntry.image._memoq?.alt || "Article Image";
                                // Removing conflicting styles, just standard img
                                sectionHtml += `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" /><br/>`;
                            }
                        }
                    });
                }

                // 2. Title (Heading) (escaped: CMS text interpolated into HTML)
                if (node._memoq && node._memoq.title) {
                    // User stated heading 2 shows, so we upgrading to h2 + strong to match standard headers
                    sectionHtml += `<h2><strong>${escapeHtml(node._memoq.title)}</strong></h2>`;
                }

                // 3. Content (Recursive)
                if (node.content) {
                    sectionHtml += traverse(node.content);
                }

                return sectionHtml + "<br/>";
            }

            // Handle Grid
            if (node._template === 'Grid' && node.content) {
                return traverse(node.content);
            }

            // Handle HTMLElement (Raw HTML)
            // Intentionally NOT escaped: Rockstar ships ready-made embed markup
            // (e.g. YouTube iframes) through this node type; escaping it would
            // break the embed feature. Text nodes we compose ourselves are escaped above.
            if (node._template === 'HTMLElement' && node._memoq && node._memoq.content) {
                return node._memoq.content + "<br/>";
            }

            // Handle RockstarVideoPlayer (or generic embed)
            // In dump: _template: "RockstarVideoPlayer"
            if (node._template === 'RockstarVideoPlayer') {
                // Usually videos might need special handling or might simply not be supported well in RSS without iframe
                // We can try to add a link or placeholder if needed, but for now ignoring or basic check
                // If there's no direct video URL, meaningful support is hard.
            }

            // Handle Embed
            if (node._template === 'Embed' && node.items && Array.isArray(node.items)) {
                node.items.forEach(item => {
                    if (item.embed) {
                        let embedCode = item.embed;

                        // Fix double '?' in URL if present
                        // Regex to find src="..." and fix query params inside it
                        embedCode = embedCode.replace(/src="([^"]+)"/g, (match, url) => {
                            const parts = url.split('?');
                            if (parts.length > 2) {
                                // Reconstruct: part[0]?part[1]&part[2]...
                                let newUrl = parts[0] + '?' + parts[1];
                                for (let i = 2; i < parts.length; i++) {
                                    newUrl += '&' + parts[i];
                                }
                                return `src="${newUrl}"`;
                            }
                            return match;
                        });

                        // Adjust size to 100% width, maintain aspect ratio if possible, or just remove fixed dimensions
                        // Replacing width="..." and height="..." with style="width:100%; aspect-ratio:16/9;"
                        embedCode = embedCode.replace(/width="\d+"/g, 'width="100%"');
                        embedCode = embedCode.replace(/height="\d+"/g, 'style="aspect-ratio: 16/9;"');

                        sectionHtml += embedCode + "<br/>";
                    }
                });
                return sectionHtml;
            }

            // Fallback: Traverse generic object keys if it's strictly a container we missed
            // But generally sticking to the templates above is cleaner.
            // However, let's process 'content' key if it exists on unknown nodes
            if (node.content) {
                return traverse(node.content);
            }
        }
        return "";
    };

    const contentHtml = traverse(post.tina.payload.content);
    return (autoHtml + contentHtml) || post.title;
}

module.exports = {
    DEFAULT_DISCORD_AVATAR_URL,
    escapeHtml,
    parseContent,
    formatDate,
    sanitizeFeedFilename,
    isValidDiscordWebhookUrl
};
