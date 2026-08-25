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
const { formatDate, DEFAULT_DISCORD_AVATAR_URL } = require('./utils');
const log = require('./logger');
const newsDir = path.join(__dirname, '../config/newswire_articles.json');
const mainLink = 'https://graph.rockstargames.com?';
const REQUEST_TIMEOUT_MS = 30000;
const PAGE_LOAD_TIMEOUT_MS = 60000;
const TOKEN_WAIT_TIMEOUT_MS = 90000;
const DEFAULT_REFRESH_INTERVAL_MS = 7.2e+6; // 2 hours in milliseconds
const RATE_LIMIT_DELAY_MS = 1000;
const DISCORD_SEND_RETRIES = 3;
const DISCORD_RETRY_DELAY_MS = 2000;
const TOKEN_FETCH_ATTEMPTS = 3;
const TOKEN_RETRY_DELAY_MS = 5000;
const PERSISTED_QUERY_NOT_FOUND = 'PersistedQueryNotFound';
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
                log.error('[ERROR] Failed to read articles file:', err);
                articles = {};
            }
        } else {
            try {
                articles = jsonString ? JSON.parse(jsonString) : {};
            } catch (e) {
                log.error('[ERROR] Failed to parse articles JSON (First 50 chars):', jsonString.substring(0, 50));
                log.error('[ERROR] Parse error:', e);
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

        // Error boundary: a rejected main() must never become an unhandled
        // rejection (that would kill the whole process). The failing genre
        // stops being polled and the error is logged loudly instead.
        this.main().catch(e => {
            log.error(`[ERROR] Startup failed for genre "${this.genre}"; it will not be polled:`, e);
        });
    }

    async main() {
        // Ensure data is loaded before starting
        await articlesLoaded;

        log.info('[READY] Started news feed for ' + this.genre + '.');
        newsHash = await acquireHashWithRetries();

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
                log.info(`[REFRESH] Previous refresh for ${this.genre} still in progress, skipping tick.`);
                return;
            }
            this.isRefreshing = true;
            try {
                log.info('[REFRESH] Refreshing news feed for ' + this.genre);

                if (this.enableRSS) {
                    const items = await this.updateRSS();
                    if (this.onRSSUpdate) this.onRSSUpdate(items);
                }

                newArticles = await this.getNewArticles();
                await this.processNewArticles(newArticles);
            } catch (e) {
                // Error boundary for the poll cycle: without this, a rejection
                // escapes the async interval callback as an unhandled rejection
                // and terminates the whole process.
                log.error(`[ERROR] Poll cycle failed for ${this.genre}:`, e);
            } finally {
                this.isRefreshing = false;
            }
        }, this.refreshInterval);
    }

    async sendArticle(article) {
        if (!this.webhook) return true;
        log.info(`[NEW] ${this.genre}: ${article.title} (${article.link})`);

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
                log.error(`[ERROR] Discord delivery failed (attempt ${attempt}/${DISCORD_SEND_RETRIES}) for "${article.title}", retrying in ${DISCORD_RETRY_DELAY_MS}ms`);
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
                    log.error('[ERROR] Unable to process request: ' + res.statusCode + '\nReason: ' + res.statusMessage);
                } else {
                    log.info('[DISCORD] Notification sent successfully.');
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
                log.error('[ERROR] Discord webhook request failed:', err.message);
                resolve(false);
            });

            req.write(JSON.stringify(payload));
            req.end();
        });
    }

    async processNewArticles(newArticles) {
        if (!newArticles || newArticles.length === 0) {
            log.info(`[CHECK] No new articles found for ${this.genre}`);
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
                log.error(`[ERROR] Failed to deliver article ${article.id} after ${DISCORD_SEND_RETRIES} attempts; will retry next refresh.`);
            }
            await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS)); // Rate limit between sends
        }
    }

    // Performs the list request, refreshing the rotating hash once if Rockstar
    // reports the persisted query as unknown. Resolves to the response object,
    // or null if the request ultimately failed.
    async requestListWithTokenRefresh() {
        let res = await this.processRequest().catch(e => {
            log.error(`[ERROR] Newswire list request failed for ${this.genre}:`, e.message);
            return null;
        });

        const hashExpired = res && res.errors != null && res.data == null
            && res.errors[0]?.message === PERSISTED_QUERY_NOT_FOUND;
        if (!hashExpired) return res;

        log.info('[HASH] Token has expired, generating new one.');
        try {
            newsHash = await acquireHashWithRetries();
        } catch (e) {
            log.error('[ERROR] Token refresh failed:', e.message);
            return null;
        }
        return this.processRequest().catch(e => {
            log.error(`[ERROR] Newswire list request failed after token refresh for ${this.genre}:`, e.message);
            return null;
        });
    }

    async getNewArticles() {
        log.info(`[CHECK] Checking for new articles in ${this.genre} (Limit: ${this.checkLimit})`);
        try {
            const res = await this.requestListWithTokenRefresh();
            if (!res || !res.data || !res.data.posts) return [];

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
                        log.error('[ERROR] Failed to fetch article details for subtitle:', err);
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

        } catch (e) {
            log.error(`[ERROR] Failed to check for new articles in ${this.genre}:`, e);
            return [];
        }
    }

    async updateRSS() {
        try {
            const res = await this.requestListWithTokenRefresh();

            if (!res || !res.data || !res.data.posts) {
                log.info('[RSS] No data received.');
                return []; // Always resolve to an array — callers iterate the result
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
                        content = parseContent(fullArticle);
                    }
                } catch (e) {
                    log.error(`[RSS] Failed to fetch content for ${post.id}:`, e.message);
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
            log.error('[RSS] Failed to fetch/parse feed data:', e);
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
        log.info('Article ID: ' + article + ' already exists in database.');
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
        log.error('[ERROR] Failed to save articles to db:', err);
    }
}

let tokenPromise = null;

// Fetches the rotating API hash, retrying a bounded number of times so a
// transient Chrome/page failure doesn't kill the genre's startup.
async function acquireHashWithRetries() {
    let lastError;
    for (let attempt = 1; attempt <= TOKEN_FETCH_ATTEMPTS; attempt++) {
        try {
            return await getHashToken();
        } catch (e) {
            lastError = e;
            log.error(`[ERROR] Token fetch failed (attempt ${attempt}/${TOKEN_FETCH_ATTEMPTS}):`, e.message);
            if (attempt < TOKEN_FETCH_ATTEMPTS) {
                await new Promise(r => setTimeout(r, TOKEN_RETRY_DELAY_MS));
            }
        }
    }
    throw lastError;
}

function getHashToken() {
    if (tokenPromise) return tokenPromise;
    log.info('[INIT] Fetching API Token (this may take a minute)...');
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
        // or rejects if that never happens within TOKEN_WAIT_TIMEOUT_MS ms.
        const hashFound = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('Timed out waiting for NewswireList request on the Newswire page'));
            }, TOKEN_WAIT_TIMEOUT_MS);
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
    getHashToken,
    genres
};
