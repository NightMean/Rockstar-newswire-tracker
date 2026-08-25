// Generates RSS feed files from per-genre article collections.
// Merged mode writes a single feed.xml; separate mode writes one
// feed-<genre>.xml per genre present in the collection.
const fs = require('fs');
const path = require('path');
const log = require('./logger');

async function generateFeeds(allArticles, { feedsDir, mergeFeeds }) {
    if (mergeFeeds) {
        // Collect ALL items from all updated genres
        let mergedItems = [];
        Object.values(allArticles).forEach(items => {
            mergedItems = mergedItems.concat(items);
        });

        // Sort by date descending
        mergedItems.sort((a, b) => b.date - a.date);

        const feed = await createFeedObject("Rockstar Newswire (Merged)", "Latest news from Rockstar Games (All Genres)");
        mergedItems.forEach(item => feed.addItem(item));

        try {
            fs.writeFileSync(path.join(feedsDir, 'feed.xml'), feed.rss2());
        } catch (e) {
            log.error('[RSS] Failed to write feed.xml:', e);
        }
        return;
    }

    // Generate separate feeds for each genre present in allArticles
    for (const [genre, items] of Object.entries(allArticles)) {
        const urlGenre = genre.replace(/_/g, '-');
        const filename = `feed-${urlGenre}.xml`;
        const feed = await createFeedObject(`Rockstar Newswire (${genre})`, `Latest news for ${genre}`);

        items.forEach(item => feed.addItem(item));

        try {
            fs.writeFileSync(path.join(feedsDir, filename), feed.rss2());
        } catch (e) {
            log.error(`[RSS] Failed to write ${filename}:`, e);
        }
    }
}

async function createFeedObject(title, description) {
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

module.exports = { generateFeeds };
