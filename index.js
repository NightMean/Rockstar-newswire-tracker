const fs = require('fs');
const http = require('http');
const path = require('path');
const yaml = require('js-yaml');
const { newswire } = require('./src/newswire');

// Feed output directory, created on startup so fresh installs can write feeds
const FEEDS_DIR = path.join(__dirname, 'feeds');
fs.mkdirSync(FEEDS_DIR, { recursive: true });

// Load Configuration
let config;
try {
    const fileContents = fs.readFileSync('./config/config.yaml', 'utf8');
    config = yaml.load(fileContents);
} catch (e) {
    console.error('[ERROR] Failed to load config.yaml:', e);
    process.exit(1);
}

// Environment Variable Override for Webhook
if (process.env.DISCORD_WEBHOOK_URL) {
    config.webhookUrl = process.env.DISCORD_WEBHOOK_URL;
}

// Validate Webhook for Discord
if (config.enableDiscord && (!config.webhookUrl || config.webhookUrl === 'YOUR_WEBHOOK_URL_HERE')) {
    console.error('[ERROR] Discord is enabled but Webhook URL is not configured. Please check config.yaml or set DISCORD_WEBHOOK_URL env variable.');
    process.exit(1);
}

const genres = config.genres || ['latest'];
const PORT = process.env.PORT || 3000;
// Default to merged if not specified
const MERGE_FEEDS = config.mergeFeeds !== false;

// Validate refresh interval: must be a positive number of minutes, otherwise
// the polling interval would be degenerate (e.g. setInterval(..., 0) hot-loop).
const refreshIntervalMinutes = Number(config.refreshInterval);
if (!Number.isFinite(refreshIntervalMinutes) || refreshIntervalMinutes <= 0) {
    console.error('[ERROR] config.refreshInterval must be a positive number of minutes, got: ' + JSON.stringify(config.refreshInterval));
    process.exit(1);
}

// Validate date format against the supported set (loud default, see formatDate)
const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY'];
let dateFormat = config.dateFormat || 'DD/MM/YYYY';
if (!DATE_FORMATS.includes(dateFormat)) {
    console.error(`[ERROR] Unsupported dateFormat "${dateFormat}", using "DD/MM/YYYY". Supported: ${DATE_FORMATS.join(', ')}`);
    dateFormat = 'DD/MM/YYYY';
}

// Store articles for each genre: { genreName: [items] }
const allArticles = {};

// Start Newswire Instances
const packageJson = require('./package.json');
console.log(`[INIT] Starting Rockstar Newswire Tracker v${packageJson.version}`);
console.log(`[INIT] Enabled Genres: ${genres.join(', ')}`);
console.log(`[INIT] Services: Discord=${config.enableDiscord}, RSS=${config.enableRSS}`);
console.log(`[INIT] RSS Mode: ${MERGE_FEEDS ? 'Merged (feed.xml)' : 'Separate (feed-[genre].xml)'}`);

genres.forEach(genre => {
    // We pass the config options to the class
    new newswire(genre, {
        webhookUrl: config.enableDiscord ? config.webhookUrl : null,
        enableRSS: config.enableRSS,
        refreshInterval: refreshIntervalMinutes * 60 * 1000, // Convert minutes to ms
        discordProfileName: config.discordProfileName || "Rockstar Newswire Tracker",
        discordAvatarUrl: config.discordAvatarUrl || "https://yt3.googleusercontent.com/-jCZaDR8AoEgC6CBPWFubF2PMSOTGU3nJ4VOSo7aq3W6mR8tcRCgygd8fS-4Ra41oHPo3F3P=s900-c-k-c0x00ffffff-no-rj",
        dateFormat: dateFormat,
        checkLimit: Math.max(1, config.checkLimit || 5), // Default 5, Min 1
        onRSSUpdate: (items) => {
            console.log(`[RSS] Received ${items.length} articles for ${genre}`);
            allArticles[genre] = items;
            generateRSS();
        }
    });
});

async function generateRSS() {
    if (MERGE_FEEDS) {
        // Collect ALL items from all updated genres
        let mergedItems = [];
        Object.values(allArticles).forEach(items => {
            mergedItems = mergedItems.concat(items);
        });

        // Sort by date descending
        mergedItems.sort((a, b) => b.date - a.date);

        const feed = await createFeedObject("Rockstar Newswire (Merged)", "Latest news from Rockstar Games (All Genres)", "feed.xml");
        mergedItems.forEach(item => feed.addItem(item));

        try {
            fs.writeFileSync(path.join(FEEDS_DIR, 'feed.xml'), feed.rss2());
            // console.log('[RSS] Merged feed.xml updated.');
        } catch (e) {
            console.error('[RSS] Failed to write feed.xml:', e);
        }

    } else {
        // Generate separate feeds for each genre present in allArticles
        // We need to use for...of to await async creation
        for (const genre of Object.keys(allArticles)) {
            const items = allArticles[genre];
            const urlGenre = genre.replace(/_/g, '-');
            const filename = `feed-${urlGenre}.xml`;
            const feed = await createFeedObject(`Rockstar Newswire (${genre})`, `Latest news for ${genre}`, filename);

            items.forEach(item => feed.addItem(item));

            try {
                fs.writeFileSync(path.join(FEEDS_DIR, filename), feed.rss2());
                // console.log(`[RSS] ${filename} updated.`);
            } catch (e) {
                console.error(`[RSS] Failed to write ${filename}:`, e);
            }
        }
    }
}

async function createFeedObject(title, description, linkPath) {
    const { Feed } = await import('feed');
    return new Feed({
        title: title,
        description: description,
        id: "https://www.rockstargames.com/newswire",
        link: "https://www.rockstargames.com/newswire",
        language: "en",
        image: "https://img.icons8.com/color/48/000000/rockstar-games.png",
        favicon: "https://www.rockstargames.com/favicon.ico",
        copyright: "All rights reserved by Rockstar Games",
        updated: new Date(),
        generator: "Rockstar Newswire RSS Generator",
        author: {
            name: "Rockstar Games",
            link: "https://www.rockstargames.com"
        }
    });
}

// Start RSS Server if enabled
if (config.enableRSS) {
    const server = http.createServer((req, res) => {
        console.log(`[SERVER] Request: ${req.method} ${req.url}`);

        // Routing
        let targetFile = null;
        if (MERGE_FEEDS) {
            if (req.url === '/' || req.url === '/rss' || req.url === '/feed.xml') {
                targetFile = 'feed.xml';
            }
        } else {
            // Try to match /feed-[genre].xml
            if (req.url.startsWith('/feed-') && req.url.endsWith('.xml')) {
                targetFile = req.url.substring(1); // remove leading /
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
                        console.error('[SERVER] Error reading feed file:', err);
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

    server.listen(PORT, () => {
        if (MERGE_FEEDS) {
            console.log(`[SERVER] RSS Feed running at http://localhost:${PORT}/feed.xml`);
        } else {
            console.log(`[SERVER] RSS Feeds available at:`);
            console.log(`http://localhost:${PORT}/`); // Index page
            genres.forEach(g => {
                console.log(`http://localhost:${PORT}/feed-${g.replace(/_/g, '-')}.xml`);
            });
        }
    });
} else {
    // If RSS is disabled, we might still want to keep the process alive if Discord is enabled
    // The newswire class uses setInterval, so the process will stay alive unless crashed/stopped.
    console.log('[SERVER] RSS Server is disabled in config.');
}
