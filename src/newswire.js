const genres = {
    latest: null,
    events: 13,
    max_payne: 25,
    max_payne_3: 27,
    music: 30,
    red_dead_redemption: 40,
    rockstar: 43,
    la_noire: 86,
    game_tips: 121,
    contest: 161,
    warehouse: 191,
    grand_theft_auto_v: 591,
    crews: 621,
    sales: 661,
    grand_theft_auto_vi: 666,
    gta_online: 702,
    content_updates: 705,
    updates: 705,
    fan_videos: 706,
    fan_art: 708,
    livestream: 711,
    twitch: 712,
    red_dead_redemption_2: 716,
    announcements: 722,
    crews_recruiting: 725,
    gameplay_clips: 727,
    creator_jobs: 728,
    in_memoriam: 730,
    backward_compatibility: 735,
    red_dead_online: 736,
    rockstar_launcher: 739,
    grand_theft_auto_the_trilogy: 751,
    circoloco_records: 1005,
};
const puppeteer = require('puppeteer');
const {
    request
} = require('https');
const fs = require('fs');
const path = require('path');
const { escapeHtml, formatDate, DEFAULT_DISCORD_AVATAR_URL } = require('./utils');
const newsDir = path.join(__dirname, '../config/newswire_articles.json');
const mainLink = 'https://graph.rockstargames.com?';
const REQUEST_TIMEOUT_MS = 30000;
const PAGE_LOAD_TIMEOUT_MS = 60000;
const TOKEN_WAIT_TIMEOUT_MS = 90000;
const DEFAULT_REFRESH_INTERVAL_MS = 7.2e+6; // 2 hours in milliseconds
const RATE_LIMIT_DELAY_MS = 1000;
const DISCORD_SEND_RETRIES = 3;
const DISCORD_RETRY_DELAY_MS = 2000;
const requestOptions = {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
    },
    timeout: REQUEST_TIMEOUT_MS,
};
let articles, newsHash;

const articlesLoaded = new Promise((resolve, reject) => {
    fs.readFile(newsDir, 'utf8', (err, jsonString) => {
        if (err) {
            if (err.code === 'ENOENT') {
                articles = {};
            } else {
                console.error('[ERROR] Failed to read articles file:', err);
                articles = {};
            }
        } else {
            try {
                articles = jsonString ? JSON.parse(jsonString) : {};
            } catch (e) {
                console.error('[ERROR] Failed to parse articles JSON (First 50 chars):', jsonString.substring(0, 50));
                console.error('[ERROR] Parse error:', e);
                articles = {};
            }
        }
        resolve(articles);
    });
});

class newswire {
    constructor(genre, options) {
        if (typeof genres[genre] == 'undefined') {
            throw new Error('Invalid genre "' + genre + '". Available genres: ' + Object.keys(genres).join(', '));
        }
        this.genre = genre;
        this.genreID = genres[genre];
        this.webhook = options.webhookUrl;
        this.enableRSS = options.enableRSS;
        this.onRSSUpdate = options.onRSSUpdate; // Callback for RSS data
        this.refreshInterval = options.refreshInterval || DEFAULT_REFRESH_INTERVAL_MS;
        this.discordProfileName = options.discordProfileName;
        this.discordAvatarUrl = options.discordAvatarUrl;
        this.dateFormat = options.dateFormat;
        this.checkLimit = options.checkLimit || 5;

        // Remove direct main() call from constructor to allow async/better flow control if needed, 
        // but for now keeping it to match original behavior but invoking with new config
        this.main();
    }

    async main() {
        // Ensure data is loaded before starting
        await articlesLoaded;

        // console.log('[READY] Started news feed for ' + this.genre + '. Feed refreshes every ' + (this.refreshInterval / 60000) + ' minutes.');
        // console.log('[INIT] Fetching API Token (this may take a minute)...'); // Moved to getHashToken
        console.log('[READY] Started news feed for ' + this.genre + '.');
        newsHash = await getHashToken();

        if (this.enableRSS) {
            const items = await this.updateRSS();
            if (this.onRSSUpdate) this.onRSSUpdate(items);
        }

        let newArticles = await this.getNewArticles();
        await this.processNewArticles(newArticles);

        this.isRefreshing = false;
        setInterval(async _ => {
            // Skip a tick if the previous refresh is still running (e.g. slow
            // article fetches) so ticks never overlap and double-send.
            if (this.isRefreshing) {
                console.log(`[REFRESH] Previous refresh for ${this.genre} still in progress, skipping tick.`);
                return;
            }
            this.isRefreshing = true;
            try {
                console.log('[REFRESH] Refreshing news feed for ' + this.genre);

                if (this.enableRSS) {
                    const items = await this.updateRSS();
                    if (this.onRSSUpdate) this.onRSSUpdate(items);
                }

                newArticles = await this.getNewArticles();
                await this.processNewArticles(newArticles);
            } finally {
                this.isRefreshing = false;
            }
        }, this.refreshInterval);
    }

    async sendArticle(article) {
        if (!this.webhook) return true;
        console.log(`[NEW] ${this.genre}: ${article.title} (${article.link})`);

        const dateStr = formatDate(article.date, this.dateFormat);
        const tagsJoined = Array.isArray(article.tags) ? article.tags.join(', ') : '';

        // Construct Webhook Payload with custom username/avatar and embed
        const payload = {
            username: this.discordProfileName,
            avatar_url: this.discordAvatarUrl,
            embeds: [{
                'author': {
                    'name': 'Rockstar Newswire',
                    'url': 'https://www.rockstargames.com/newswire',
                    'icon_url': DEFAULT_DISCORD_AVATAR_URL
                },
                'title': article.title,
                'url': article.link,
                'description': article.subtitle || "",
                'color': 16756992,
                'fields': [],
                'image': {
                    'url': article.img
                },
                'footer': {
                    "text": tagsJoined + ' • ' + dateStr
                }
            }]
        };

        for (let attempt = 1; attempt <= DISCORD_SEND_RETRIES; attempt++) {
            const delivered = await this.deliverWebhook(payload);
            if (delivered) return true;
            if (attempt < DISCORD_SEND_RETRIES) {
                console.error(`[ERROR] Discord delivery failed (attempt ${attempt}/${DISCORD_SEND_RETRIES}) for "${article.title}", retrying in ${DISCORD_RETRY_DELAY_MS}ms`);
                await new Promise(r => setTimeout(r, DISCORD_RETRY_DELAY_MS));
            }
        }
        return false;
    }

    deliverWebhook(payload) {
        return new Promise((resolve) => {
            const req = request(this.webhook, requestOptions, (res) => {
                const ok = res.statusCode >= 200 && res.statusCode <= 299;
                if (!ok) {
                    console.error('[ERROR] Unable to process request: ' + res.statusCode + '\nReason: ' + res.statusMessage);
                } else {
                    console.log('[DISCORD] Notification sent successfully.');
                }
                // Vital: Consume response data to free up memory and prevent timeout
                res.resume();
                resolve(ok);
            });
            req.on('timeout', () => {
                // Destroying the socket emits 'error' below, which resolves(false)
                req.destroy(new Error('Request timedout'));
            });
            req.on('error', (err) => {
                console.error('[ERROR] Discord webhook request failed:', err.message);
                resolve(false);
            });

            req.write(JSON.stringify(payload));
            req.end();
        });
    }

    async processNewArticles(newArticles) {
        if (!newArticles || newArticles.length === 0) {
            console.log(`[CHECK] No new articles found for ${this.genre}`);
            return;
        }

        newArticles.reverse(); // Send oldest first
        for (const article of newArticles) {
            const delivered = await this.sendArticle(article);

            if (delivered) {
                // Persist as seen only after a successful delivery so a failed
                // send is retried on the next refresh instead of being lost.
                addArticle(article.id.toString(), article.link);
            } else {
                console.error(`[ERROR] Failed to deliver article ${article.id} after ${DISCORD_SEND_RETRIES} attempts; will retry next refresh.`);
            }
            await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS)); // Rate limit between sends
        }
    }

    async getNewArticles() {
        console.log(`[CHECK] Checking for new articles in ${this.genre} (Limit: ${this.checkLimit})`);
        return this.processRequest().then(async (res) => {
            if (res && res.errors != null) {
                if (res.data == null && res.errors[0].message == 'PersistedQueryNotFound') {
                    console.log('[HASH] Token has expired, generating new one.');
                    newsHash = await getHashToken().catch(console.log);
                    res = await this.processRequest().catch(console.log);
                } else {
                    return [];
                }
            }

            const results = res.data.posts.results;
            if (!results || results.length === 0) return [];

            const foundNewArticles = [];
            // Check up to checkLimit articles
            const limit = Math.min(results.length, this.checkLimit);

            for (let i = 0; i < limit; i++) {
                let article = results[i];
                let check = articles && articles[article.id];

                if (!check) {
                    // Found a new one!
                    // Note: NOT marked as seen here — the article is persisted
                    // only after its Discord delivery succeeds in processNewArticles.
                    const tags = (article.primary_tags || []).map(tag => tag.name);
                    article.url = 'https://www.rockstargames.com' + article.url;
                    let subtitle = "";
                    try {
                        const fullDetails = await this.getArticle(article.id);
                        if (fullDetails && fullDetails.tina && fullDetails.tina.payload && fullDetails.tina.payload.meta) {
                            subtitle = fullDetails.tina.payload.meta.subtitle || "";
                        }
                    } catch (err) {
                        console.error('[ERROR] Failed to fetch article details for subtitle:', err);
                    }

                    foundNewArticles.push({
                        id: article.id,
                        title: article.title,
                        link: article.url,
                        img: article.preview_images_parsed?.newswire_block?.d16x9 || "",
                        date: article.created,
                        tags: tags,
                        subtitle: subtitle
                    });
                }
            }

            return foundNewArticles;

        }).catch(e => {
            console.log(e);
            return [];
        });
    }

    async updateRSS() {
        // console.log('[RSS] Updating RSS feed...'); // Redundant with index.js log
        try {
            let res = await this.processRequest().catch(console.log);

            if (res && res.errors != null) {
                if (res.data == null && res.errors[0].message == 'PersistedQueryNotFound') {
                    console.log('[RSS] Token has expired, generating new one.');
                    newsHash = await getHashToken().catch(console.log);
                    res = await this.processRequest().catch(console.log);
                }
            }

            if (!res || !res.data || !res.data.posts) {
                console.log('[RSS] No data received.');
                return;
            }

            const posts = res.data.posts.results;

            // Single pass over the article list: fetch full content and map to feed items.
            const feedItems = [];
            for (const post of posts) {
                let imageUrl = "";
                try {
                    imageUrl = post.preview_images_parsed.newswire_block.d16x9;
                } catch (e) { }

                let link = 'https://www.rockstargames.com' + post.url;
                let content = post.title; // Default fall back

                try {
                    const fullArticle = await this.getArticle(post.id);
                    if (fullArticle) {
                        content = this.parseContent(fullArticle);
                    }
                } catch (e) {
                    console.error(`[RSS] Failed to fetch content for ${post.id}:`, e.message);
                }

                feedItems.push({
                    title: post.title,
                    id: post.id.toString(),
                    link: link,
                    description: post.title, // Description is often summary, but using title as fallback
                    content: content,
                    author: [
                        {
                            name: "Rockstar Games",
                            link: "https://www.rockstargames.com"
                        }
                    ],
                    date: new Date(post.created),
                    image: imageUrl,
                    // Additional metadata for multiple feeds if needed
                    category: this.genre
                });
            }

            return feedItems;

        } catch (e) {
            console.error('[RSS] Failed to fetch/parse feed data:', e);
            return [];
        }
    }

    async getArticle(id) {
        const searchParams = new URLSearchParams([
            ['operationName', 'NewswirePost'],
            ['variables', JSON.stringify({
                locale: 'en_us',
                id_hash: id
            })],
            ['extensions', JSON.stringify({
                persistedQuery: {
                    version: 1,
                    sha256Hash: '555658813abe5acc8010de1a1feddd6fd8fddffbdc35d3723d4dc0fe4ded6810'
                }
            })]
        ]);

        return new Promise((resolve) => {
            const req = request(mainLink + searchParams.toString(), requestOptions, (res) => {
                if (res.statusCode < 200 || res.statusCode > 299) {
                    // Consume the body so the socket is freed, then skip this article
                    res.resume();
                    resolve(null);
                    return;
                }

                let responseBody = "";
                res.on('data', (chunk) => { responseBody += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(responseBody);
                        resolve(json.data && json.data.post ? json.data.post : null);
                    } catch (e) { resolve(null); }
                });
            });
            req.on('timeout', () => {
                // Destroying emits 'error' below, which resolves(null)
                req.destroy(new Error('Article request timed out'));
            });
            req.on('error', () => { resolve(null); });
            req.end();
        });
    }

    parseContent(post) {
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

    processRequest() {
        const searchParams = new URLSearchParams([
            ['operationName', 'NewswireList'],
            ['variables', JSON.stringify({
                page: 1,
                tagId: this.genreID,
                metaUrl: '/newswire',
                locale: 'en_us'
            })],
            ['extensions', JSON.stringify({
                persistedQuery: {
                    version: 1,
                    sha256Hash: newsHash
                }
            })]
        ]);

        return new Promise((resolve, reject) => {
            const req = request(mainLink + searchParams.toString(), requestOptions, (res) => {
                if (res.statusCode < 200 || res.statusCode > 299) {
                    // Consume the body so the socket is freed, then fail with status context
                    res.resume();
                    reject(new Error('[ERROR] Unable to process request: ' + res.statusCode + '\nReason: ' + res.statusMessage));
                    return;
                }

                res.setEncoding('utf8');
                let responseBody = "";
                res.on('data', (chunk) => {
                    responseBody += chunk;
                });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(responseBody));
                    } catch (e) {
                        reject(new Error('Failed to parse API response as JSON: ' + e.message));
                    }
                });
            });
            req.on('timeout', () => {
                // Destroying the socket emits 'error' below, which rejects
                req.destroy(new Error('Request timed out after ' + requestOptions.timeout + 'ms'));
            });
            req.on('error', reject);
            req.end();
        });
    }
}

function addArticle(article, url) {
    if (!articles) return;
    if (articles[article]) {
        console.log('Article ID: ' + article + ' already exists in database.');
        return;
    }

    articles[article] = url;
    try {
        // Write-then-rename so a crash mid-write cannot corrupt the seen-articles
        // DB (a corrupt file previously reset all history and re-spammed Discord).
        const tmpPath = newsDir + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(articles, null, 2));
        fs.renameSync(tmpPath, newsDir);
    } catch (err) {
        console.error('[ERROR] Failed to save articles to db:', err);
    }
}

let tokenPromise = null;
function getHashToken() {
    if (tokenPromise) return tokenPromise;
    console.log('[INIT] Fetching API Token (this may take a minute)...');
    tokenPromise = fetchHashToken();
    // Allow a retry on the next call if this attempt failed
    tokenPromise.catch(() => { tokenPromise = null; });
    return tokenPromise;
}

async function fetchHashToken() {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        await page.setRequestInterception(true);

        // Resolves with the hash once the page issues its NewswireList request,
        // or rejects if that never happens within TOKEN_WAIT_TIMEOUT ms.
        const hashFound = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('Timed out waiting for NewswireList request on the Newswire page'));
            }, TOKEN_WAIT_TIMEOUT);
            page.on('request', interceptedRequest => {
                if (interceptedRequest.url().includes('operationName=NewswireList')) {
                    let url = interceptedRequest.url();
                    let params = url.split('?')[1];
                    let query = new URLSearchParams(params);
                    for (let pair of query.entries()) {
                        if (pair[0] == 'extensions' && pair[1]) {
                            clearTimeout(timer);
                            interceptedRequest.abort();
                            resolve(JSON.parse(pair[1])['persistedQuery']['sha256Hash']);
                            return;
                        }
                    }
                }
                interceptedRequest.continue();
            });
        });

        await page.goto('https://www.rockstargames.com/newswire', { waitUntil: 'networkidle2', timeout: PAGE_LOAD_TIMEOUT });
        return await hashFound;
    } catch (e) {
        throw (e instanceof Error) ? e : new Error(String(e));
    } finally {
        try { await browser.close(); } catch (e) { /* browser already closed */ }
    }
}

module.exports = {
    newswire,
    getHashToken
};
