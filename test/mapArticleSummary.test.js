const { test } = require('node:test');
const assert = require('node:assert');
const { mapArticleSummary } = require('../src/newswireApi');

// Fixture shaped like a real NewswireList result entry
const apiPost = {
    id: '9k2kaa1o3297k9',
    title: 'Grand Theft Auto VI: An Extended Look',
    url: '/newswire/article-slug',
    created: '2026-08-06T08:00:00Z',
    primary_tags: [
        { name: 'Rockstar Games' },
        { name: 'GTA VI' }
    ],
    preview_images_parsed: {
        newswire_block: {
            d16x9: 'https://media-rockstargames-com.akamaized.net/img/hero.png'
        }
    }
};

test('mapArticleSummary maps all fields used by Discord embeds and bookkeeping', () => {
    const summary = mapArticleSummary(apiPost);
    assert.deepStrictEqual(summary, {
        id: '9k2kaa1o3297k9',
        title: 'Grand Theft Auto VI: An Extended Look',
        link: 'https://www.rockstargames.com/newswire/article-slug',
        img: 'https://media-rockstargames-com.akamaized.net/img/hero.png',
        date: '2026-08-06T08:00:00Z',
        tags: ['Rockstar Games', 'GTA VI'],
        subtitle: ''
    });
});

test('mapArticleSummary tolerates missing preview images', () => {
    const summary = mapArticleSummary({ ...apiPost, preview_images_parsed: {} });
    assert.strictEqual(summary.img, '');
});

test('mapArticleSummary tolerates missing tags', () => {
    const summary = mapArticleSummary({ ...apiPost, primary_tags: null });
    assert.deepStrictEqual(summary.tags, []);
});
