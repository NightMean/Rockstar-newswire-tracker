// Per-genre polling orchestrator. Owns the refresh loop: fetch the article
// list, update RSS via callback, deliver unseen articles to Discord, and
// persist them as seen only after successful delivery.
const log = require('./logger');
const {
    PERSISTED_QUERY_NOT_FOUND,
    mapArticleSummary,
    acquireHashWithRetries,
    NewswireApi
} = require('./newswireApi');
const { parseContent } = require('./utils');

const DEFAULT_REFRESH_INTERVAL_MS = 7.2e+6; // 2 hours in milliseconds
const RATE_LIMIT_DELAY_MS = 1000;
const DEFAULT_CHECK_LIMIT = 5;

class NewswirePoller {
    constructor({ genre, tagId, store, notifier, onRSSUpdate, options = {} }) {
        if (typeof tagId === 'undefined') {
            throw new Error('Unknown tagId for genre "' + genre + '"');
        }
        this.genre = genre;
        this.store = store;
        this.notifier = notifier;
        this.onRSSUpdate = onRSSUpdate;
        this.enableRSS = Boolean(options.enableRSS);
        this.refreshInterval = options.refreshInterval || DEFAULT_REFRESH_INTERVAL_MS;
        this.checkLimit = options.checkLimit || DEFAULT_CHECK_LIMIT;
        this.api = new NewswireApi(tagId);
        // Rotating persisted-query hash; fetched at startup, refreshed on expiry.
        this.hash = null;

        // Error boundary: a rejected start() must never become an unhandled
        // rejection (that would kill the whole process). The failing genre
        // stops being polled and the error is logged loudly instead.
        this.start().catch(e => {
            log.error(`[ERROR] Startup failed for genre "${this.genre}"; it will not be polled:`, e);
        });
    }

    async start() {
        await this.store.whenLoaded();

        log.info('[READY] Started news feed for ' + this.genre + '.');
        this.hash = await acquireHashWithRetries();

        if (this.enableRSS) {
            await this.updateRSS();
        }

        await this.processNewArticles(await this.getNewArticles());

        this.isRefreshing = false;
        setInterval(async () => this.tick(), this.refreshInterval);
    }

    async tick() {
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
                await this.updateRSS();
            }

            await this.processNewArticles(await this.getNewArticles());
        } catch (e) {
            // Error boundary for the poll cycle: without this, a rejection
            // escapes the async interval callback as an unhandled rejection
            // and terminates the whole process.
            log.error(`[ERROR] Poll cycle failed for ${this.genre}:`, e);
        } finally {
            this.isRefreshing = false;
        }
    }

    // Performs the list request, refreshing the rotating hash once if Rockstar
    // reports the persisted query as unknown. Resolves to the response object,
    // or null if the request ultimately failed.
    async requestListWithTokenRefresh() {
        let res = await this.api.fetchList(this.hash).catch(e => {
            log.error(`[ERROR] Newswire list request failed for ${this.genre}:`, e.message);
            return null;
        });

        const hashExpired = res && res.errors != null && res.data == null
            && res.errors[0]?.message === PERSISTED_QUERY_NOT_FOUND;
        if (!hashExpired) return res;

        log.info('[HASH] Token has expired, generating new one.');
        try {
            this.hash = await acquireHashWithRetries();
        } catch (e) {
            log.error('[ERROR] Token refresh failed:', e.message);
            return null;
        }
        return this.api.fetchList(this.hash).catch(e => {
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
                const post = results[i];
                if (this.store.has(post.id)) continue;

                const summary = mapArticleSummary(post);

                // Enrich with the subtitle from the full article payload
                try {
                    const fullDetails = await this.api.fetchArticle(post.id);
                    if (fullDetails?.tina?.payload?.meta) {
                        summary.subtitle = fullDetails.tina.payload.meta.subtitle || "";
                    }
                } catch (err) {
                    log.error('[ERROR] Failed to fetch article details for subtitle:', err);
                }

                foundNewArticles.push(summary);
            }

            return foundNewArticles;

        } catch (e) {
            log.error(`[ERROR] Failed to check for new articles in ${this.genre}:`, e);
            return [];
        }
    }

    async processNewArticles(newArticles) {
        if (!newArticles || newArticles.length === 0) {
            log.info(`[CHECK] No new articles found for ${this.genre}`);
            return;
        }

        newArticles.reverse(); // Send oldest first
        for (const article of newArticles) {
            const delivered = await this.notifier.send(article);

            if (delivered) {
                // Persist as seen only after a successful delivery so a failed
                // send is retried on the next refresh instead of being lost.
                this.store.markSeen(article.id.toString(), article.link);
            } else {
                log.error(`[ERROR] Failed to deliver article ${article.id}; will retry next refresh.`);
            }
            await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS)); // Rate limit between sends
        }
    }

    async updateRSS() {
        try {
            const res = await this.requestListWithTokenRefresh();

            if (!res || !res.data || !res.data.posts) {
                log.info('[RSS] No data received.');
                return this.notifyRSS([]);
            }

            // Single pass over the article list: fetch full content and map to feed items.
            const feedItems = [];
            for (const post of res.data.posts.results) {
                feedItems.push(await this.toFeedItem(post));
            }

            return this.notifyRSS(feedItems);
        } catch (e) {
            log.error('[RSS] Failed to fetch/parse feed data:', e);
            return this.notifyRSS([]);
        }
    }

    notifyRSS(items) {
        if (this.onRSSUpdate) this.onRSSUpdate(items);
        return items;
    }

    async toFeedItem(post) {
        let imageUrl = "";
        try {
            imageUrl = post.preview_images_parsed.newswire_block.d16x9;
        } catch (e) { /* preview image shape differs; fall back to empty */ }

        let content = post.title; // Default fall back

        try {
            const fullArticle = await this.api.fetchArticle(post.id);
            if (fullArticle) {
                content = parseContent(fullArticle);
            }
        } catch (e) {
            log.error(`[RSS] Failed to fetch content for ${post.id}:`, e.message);
        }

        return {
            title: post.title,
            id: post.id.toString(),
            link: 'https://www.rockstargames.com' + post.url,
            description: post.title,
            content: content,
            author: [
                {
                    name: "Rockstar Games",
                    link: "https://www.rockstargames.com"
                }
            ],
            date: new Date(post.created),
            image: imageUrl,
            category: this.genre
        };
    }
}

module.exports = { NewswirePoller };
