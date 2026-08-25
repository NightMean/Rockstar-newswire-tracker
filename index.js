const fs = require('fs');
const http = require('http');
const path = require('path');
const yaml = require('js-yaml');
const { genres: GENRE_TAG_IDS } = require('./src/newswireApi');
const { NewswirePoller } = require('./src/poller');
const { DiscordNotifier } = require('./src/discordNotifier');
const articleStore = require('./src/articleStore');
const { generateFeeds } = require('./src/feedGenerator');
const { sanitizeFeedFilename, isValidDiscordWebhookUrl, DEFAULT_DISCORD_AVATAR_URL } = require('./src/utils');
const log = require('./src/logger');

// Feed output directory, created on startup so fresh installs can write feeds
const FEEDS_DIR = path.join(__dirname, 'feeds');
fs.mkdirSync(FEEDS_DIR, { recursive: true });

// Load Configuration
let config;
try {
    const fileContents = fs.readFileSync('./config/config.yaml', 'utf8');
    config = yaml.load(fileContents);
} catch (e) {
    log.error('[ERROR] Failed to load config.yaml:', e);
    process.exit(1);
}

// Environment Variable Override for Webhook
if (process.env.DISCORD_WEBHOOK_URL) {
    config.webhookUrl = process.env.DISCORD_WEBHOOK_URL;
}

// Validate Webhook for Discord
if (config.enableDiscord && (!config.webhookUrl || config.webhookUrl === 'YOUR_WEBHOOK_URL_HERE')) {
    log.error('[ERROR] Discord is enabled but Webhook URL is not configured. Please check config.yaml or set DISCORD_WEBHOOK_URL env variable.');
    process.exit(1);
}
// A mistyped webhook URL would silently post article data to an arbitrary host
if (config.enableDiscord && !isValidDiscordWebhookUrl(config.webhookUrl)) {
    log.error('[ERROR] webhookUrl does not look like a Discord webhook URL (expected https://discord.com/api/webhooks/...). Got: ' + config.webhookUrl);
    process.exit(1);
}

const genres = config.genres || ['latest'];
// A genre listed twice would spawn two pollers for the same feed and can
// double-send Discord notifications on the first poll race.
const uniqueGenres = [...new Set(genres)];
if (uniqueGenres.length !== genres.length) {
    log.warn(`[WARN] Duplicate entries in config.genres were removed: ${genres.join(', ')}`);
}

// Warn when multiple enabled genres resolve to the same Rockstar tagId
// (e.g. content_updates and updates both map to 705): the same content is
// polled twice and the first instance to mark an article seen wins.
const seenTagIds = new Map();
for (const g of uniqueGenres) {
    const tagId = GENRE_TAG_IDS[g];
    if (tagId !== null && seenTagIds.has(tagId)) {
        log.warn(`[WARN] Genres "${seenTagIds.get(tagId)}" and "${g}" share Rockstar tagId ${tagId}; enable only one of them.`);
    } else {
        seenTagIds.set(tagId, g);
    }
}
const PORT = process.env.PORT || 3000;
// Default to merged if not specified
const MERGE_FEEDS = config.mergeFeeds !== false;

// Validate refresh interval: must be a positive number of minutes, otherwise
// the polling interval would be degenerate (e.g. setInterval(..., 0) hot-loop).
const refreshIntervalMinutes = Number(config.refreshInterval);
if (!Number.isFinite(refreshIntervalMinutes) || refreshIntervalMinutes <= 0) {
    log.error('[ERROR] config.refreshInterval must be a positive number of minutes, got: ' + JSON.stringify(config.refreshInterval));
    process.exit(1);
}

// Validate date format against the supported set (loud default, see formatDate)
const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY'];
let dateFormat = config.dateFormat || 'DD/MM/YYYY';
if (!DATE_FORMATS.includes(dateFormat)) {
    log.error(`[ERROR] Unsupported dateFormat "${dateFormat}", using "DD/MM/YYYY". Supported: ${DATE_FORMATS.join(', ')}`);
    dateFormat = 'DD/MM/YYYY';
}

// Upper bound for checkLimit: a huge value would hammer the Rockstar API
const MAX_CHECK_LIMIT = 20;
let checkLimit = Math.max(1, config.checkLimit || 5);
if (config.checkLimit > MAX_CHECK_LIMIT) {
    log.warn(`[WARN] checkLimit ${config.checkLimit} exceeds the maximum of ${MAX_CHECK_LIMIT}; using ${MAX_CHECK_LIMIT}.`);
    checkLimit = MAX_CHECK_LIMIT;
}

// Graceful shutdown: atomic writes and mark-after-delivery already make an
// abrupt stop safe; this just makes intentional stops visible in the logs.
['SIGTERM', 'SIGINT'].forEach(signal => {
    process.on(signal, () => {
        log.info(`[SHUTDOWN] Received ${signal}, exiting.`);
        process.exit(0);
    });
});

// Store articles for each genre: { genreName: [items] }
const allArticles = {};

// Start Newswire Instances
const packageJson = require('./package.json');
log.info(`[INIT] Starting Rockstar Newswire Tracker v${packageJson.version}`);
log.info(`[INIT] Enabled Genres: ${uniqueGenres.join(', ')}`);
log.info(`[INIT] Services: Discord=${config.enableDiscord}, RSS=${config.enableRSS}`);
log.info(`[INIT] RSS Mode: ${MERGE_FEEDS ? 'Merged (feed.xml)' : 'Separate (feed-[genre].xml)'}`);

uniqueGenres.forEach(genre => {
    new NewswirePoller({
        genre,
        tagId: GENRE_TAG_IDS[genre],
        store: articleStore,
        notifier: new DiscordNotifier({
            webhookUrl: config.enableDiscord ? config.webhookUrl : null,
            profileName: config.discordProfileName || "Rockstar Newswire Tracker",
            avatarUrl: config.discordAvatarUrl || DEFAULT_DISCORD_AVATAR_URL,
            dateFormat: dateFormat
        }),
        options: {
            enableRSS: config.enableRSS,
            refreshInterval: refreshIntervalMinutes * 60 * 1000, // Convert minutes to ms
            checkLimit: checkLimit
        },
        onRSSUpdate: (items) => {
            log.info(`[RSS] Received ${items.length} articles for ${genre}`);
            allArticles[genre] = items;
            generateFeeds(allArticles, { feedsDir: FEEDS_DIR, mergeFeeds: MERGE_FEEDS }).catch(e => {
                log.error('[ERROR] Failed to generate RSS feed:', e);
            });
        }
    });
});

// Start RSS Server if enabled
if (config.enableRSS) {
    const server = http.createServer((req, res) => {
        // Liveness endpoint for orchestrators; answers even while feeds initialize
        if (req.url === '/healthz') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', version: packageJson.version }));
            return;
        }

        log.info(`[SERVER] Request: ${req.method} ${req.url}`);

        // Routing
        let targetFile = null;
        if (MERGE_FEEDS) {
            if (req.url === '/' || req.url === '/rss' || req.url === '/feed.xml') {
                targetFile = 'feed.xml';
            }
        } else {
            // Try to match /feed-[genre].xml; sanitize against path traversal
            if (req.url.startsWith('/feed-') && req.url.endsWith('.xml')) {
                targetFile = sanitizeFeedFilename(req.url);
            } else if (req.url === '/' || req.url === '/rss') {
                // Index listing? Or just 404? 
                // Let's list rockstar newswire available feeds
                res.writeHead(200, { 'Content-Type': 'text/html' });
                const links = Object.keys(allArticles).map(g => {
                    const urlGenre = g.replace(/_/g, '-');
                    return `<li><a href="/feed-${urlGenre}.xml">${g}</a></li>`;
                }).join('');
                res.end(`<h1>Rockstar Newswire RSS Feeds</h1><ul>${links}</ul>`);
                return;
            }
        }

        if (targetFile) {
            fs.readFile(path.join(FEEDS_DIR, targetFile), (err, content) => {
                if (err) {
                    if (err.code === 'ENOENT') {
                        res.writeHead(503, { 'Content-Type': 'text/plain' });
                        res.end('Feed is initializing or invalid genre, please try again.');
                    } else {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Internal Server Error');
                        log.error('[SERVER] Error reading feed file:', err);
                    }
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
                    res.end(content);
                }
            });
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    });

    // Fail with a clear message instead of a raw unhandled 'error' event
    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            log.error(`[SERVER] Port ${PORT} is already in use. Stop the other process or set PORT.`);
        } else {
            log.error('[SERVER] HTTP server error:', e);
        }
        process.exit(1);
    });

    server.listen(PORT, () => {
        if (MERGE_FEEDS) {
            log.info(`[SERVER] RSS Feed running at http://localhost:${PORT}/feed.xml`);
        } else {
            log.info(`[SERVER] RSS Feeds available at:`);
            log.info(`http://localhost:${PORT}/`); // Index page
            uniqueGenres.forEach(g => {
                log.info(`http://localhost:${PORT}/feed-${g.replace(/_/g, '-')}.xml`);
            });
        }
    });
} else {
    // If RSS is disabled, we might still want to keep the process alive if Discord is enabled
    // The newswire class uses setInterval, so the process will stay alive unless crashed/stopped.
    log.info('[SERVER] RSS Server is disabled in config.');
}
