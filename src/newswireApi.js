// Client for Rockstar's persisted-query GraphQL API plus the Puppeteer-based
// hash fetcher. The list operation's sha256Hash rotates; it is captured by
// loading the Newswire page and intercepting the browser's own request.
const puppeteer = require('puppeteer');
const {
    request
} = require('https');
const log = require('./logger');

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

const mainLink = 'https://graph.rockstargames.com?';
const REQUEST_TIMEOUT_MS = 30000;
const PAGE_LOAD_TIMEOUT_MS = 60000;
const TOKEN_WAIT_TIMEOUT_MS = 90000;
const TOKEN_FETCH_ATTEMPTS = 3;
const TOKEN_RETRY_DELAY_MS = 5000;

// Separate, non-rotating persisted query for single-article bodies
const NEWSWIRE_POST_SHA256_HASH = '555658813abe5acc8010de1a1feddd6fd8fddffbdc35d3723d4dc0fe4ded6810';

const requestOptions = {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
    },
    timeout: REQUEST_TIMEOUT_MS,
};

class NewswireApi {
    constructor(genreTagId) {
        this.genreTagId = genreTagId;
    }

    // Fetches the article list. The caller supplies the current rotating hash
    // and is responsible for refreshing it on PersistedQueryNotFound.
    fetchList(sha256Hash) {
        const searchParams = new URLSearchParams([
            ['operationName', 'NewswireList'],
            ['variables', JSON.stringify({
                page: 1,
                tagId: this.genreTagId,
                metaUrl: '/newswire',
                locale: 'en_us'
            })],
            ['extensions', JSON.stringify({
                persistedQuery: {
                    version: 1,
                    sha256Hash
                }
            })]
        ]);
        return graphRequest(mainLink + searchParams.toString());
    }

    // Resolves the full article payload (tina content tree etc.) or null when
    // the article cannot be fetched — callers skip articles instead of failing.
    fetchArticle(id) {
        const searchParams = new URLSearchParams([
            ['operationName', 'NewswirePost'],
            ['variables', JSON.stringify({
                locale: 'en_us',
                id_hash: id
            })],
            ['extensions', JSON.stringify({
                persistedQuery: {
                    version: 1,
                    sha256Hash: NEWSWIRE_POST_SHA256_HASH
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
}

function graphRequest(url) {
    return new Promise((resolve, reject) => {
        const req = request(url, requestOptions, (res) => {
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

// Maps a raw NewswireList result entry to the article summary used across the
// app (Discord embeds and internal bookkeeping). Pure — tested with fixtures.
// Note: NOT marked as seen here — persistence happens only after successful delivery.
function mapArticleSummary(post) {
    return {
        id: post.id,
        title: post.title,
        link: 'https://www.rockstargames.com' + post.url,
        img: post.preview_images_parsed?.newswire_block?.d16x9 || "",
        date: post.created,
        tags: (post.primary_tags || []).map(tag => tag.name),
        subtitle: ""
    };
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

// Fallback Chrome locations when Puppeteer has no bundled browser downloaded
// (PUPPETEER_EXECUTABLE_PATH is honored by Puppeteer automatically; these are
// only tried if the default launch fails).
const CHROME_FALLBACK_PATHS = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome-stable',
];

async function launchBrowser() {
    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
    try {
        return await puppeteer.launch({ headless: true, args: launchArgs });
    } catch (e) {
        for (const executablePath of CHROME_FALLBACK_PATHS) {
            try {
                return await puppeteer.launch({ headless: true, executablePath, args: launchArgs });
            } catch (fallbackError) { /* try next location */ }
        }
        throw e;
    }
}

async function fetchHashToken() {
    const browser = await launchBrowser();

    try {
        const page = await browser.newPage();
        // Rockstar serves an empty bot-wall page to CDP-automated browsers;
        // hiding navigator.webdriver is enough to get the real page through.
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        await page.setRequestInterception(true);

        // Resolves with the hash once the page issues its NewswireList request,
        // or rejects if that never happens within TOKEN_WAIT_TIMEOUT_MS ms.
        const hashFound = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('Timed out waiting for NewswireList request on the Newswire page'));
            }, TOKEN_WAIT_TIMEOUT_MS);
            page.on('request', interceptedRequest => {
                if (interceptedRequest.url().includes('operationName=NewswireList')) {
                    const url = interceptedRequest.url();
                    const params = url.split('?')[1];
                    const query = new URLSearchParams(params);
                    for (const pair of query.entries()) {
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
        // If navigation fails first, this promise would otherwise sit pending
        // and its timeout rejection later become an unhandled rejection that
        // kills the whole process. The real error is thrown from below instead.
        hashFound.catch(() => { });

        await page.goto('https://www.rockstargames.com/newswire', { waitUntil: 'networkidle2', timeout: PAGE_LOAD_TIMEOUT_MS });
        return await hashFound;
    } catch (e) {
        throw (e instanceof Error) ? e : new Error(String(e));
    } finally {
        try { await browser.close(); } catch (e) { /* browser already closed */ }
    }
}

module.exports = {
    genres,
    NewswireApi,
    mapArticleSummary,
    acquireHashWithRetries,
    PERSISTED_QUERY_NOT_FOUND: 'PersistedQueryNotFound'
};
