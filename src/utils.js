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

module.exports = {
    DEFAULT_DISCORD_AVATAR_URL,
    escapeHtml,
    formatDate,
    sanitizeFeedFilename,
    isValidDiscordWebhookUrl
};
