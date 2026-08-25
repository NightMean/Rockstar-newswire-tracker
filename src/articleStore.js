// Owns the seen-articles database ({ articleId: url } persisted as JSON).
// The file is written atomically (temp file + rename) so a crash mid-write
// can never corrupt it — a corrupt DB previously reset all history and
// re-posted every recent article to Discord.
const fs = require('fs');
const path = require('path');
const log = require('./logger');

const newsDir = path.join(__dirname, '../config/newswire_articles.json');

let articles = null;

// Loaded once at startup; every consumer awaits this before touching the store.
const loaded = new Promise((resolve) => {
    fs.readFile(newsDir, 'utf8', (err, jsonString) => {
        if (err) {
            if (err.code !== 'ENOENT') {
                log.error('[ERROR] Failed to read articles file:', err);
            }
            articles = {};
        } else {
            try {
                articles = jsonString ? JSON.parse(jsonString) : {};
            } catch (e) {
                log.error('[ERROR] Failed to parse articles JSON (First 50 chars):', jsonString.substring(0, 50));
                log.error('[ERROR] Parse error:', e);
                articles = {};
            }
        }
        resolve();
    });
});

async function whenLoaded() {
    await loaded;
}

function has(articleId) {
    return Boolean(articles && articles[articleId]);
}

function markSeen(articleId, url) {
    if (!articles || articles[articleId]) return;
    articles[articleId] = url;

    try {
        const tmpPath = newsDir + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(articles, null, 2));
        fs.renameSync(tmpPath, newsDir);
    } catch (err) {
        log.error('[ERROR] Failed to save articles to db:', err);
    }
}

module.exports = {
    whenLoaded,
    has,
    markSeen
};
