const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeFeedFilename, isValidDiscordWebhookUrl } = require('../src/utils');

test('sanitizeFeedFilename accepts valid feed paths and strips the leading slash', () => {
    assert.strictEqual(sanitizeFeedFilename('/feed-latest.xml'), 'feed-latest.xml');
    assert.strictEqual(sanitizeFeedFilename('/feed-grand-theft-auto-vi.xml'), 'feed-grand-theft-auto-vi.xml');
    assert.strictEqual(sanitizeFeedFilename('/feed-gta_online.xml'), null); // underscores are hyphens in URLs
});

test('sanitizeFeedFilename rejects path traversal', () => {
    assert.strictEqual(sanitizeFeedFilename('/feed-../config/newswire_articles.json'), null);
    assert.strictEqual(sanitizeFeedFilename('/feed-..%2f..%2fetc.xml'), null);
    assert.strictEqual(sanitizeFeedFilename('/feed-subdir/other.xml'), null);
});

test('sanitizeFeedFilename rejects non-feed paths', () => {
    assert.strictEqual(sanitizeFeedFilename('/'), null);
    assert.strictEqual(sanitizeFeedFilename('/feed.xml'), null);
    assert.strictEqual(sanitizeFeedFilename('/feed-.xml'), null);
    assert.strictEqual(sanitizeFeedFilename(null), null);
    assert.strictEqual(sanitizeFeedFilename(''), null);
});

test('isValidDiscordWebhookUrl accepts discord.com webhook URLs', () => {
    assert.ok(isValidDiscordWebhookUrl('https://discord.com/api/webhooks/123456/abcdef'));
    assert.ok(isValidDiscordWebhookUrl('https://discordapp.com/api/webhooks/123456/abcdef'));
    assert.ok(isValidDiscordWebhookUrl('https://canary.discord.com/api/webhooks/123456/abcdef'));
    assert.ok(isValidDiscordWebhookUrl('https://ptb.discordapp.com/api/webhooks/123456/abcdef'));
});

test('isValidDiscordWebhookUrl rejects other hosts and non-strings', () => {
    assert.strictEqual(isValidDiscordWebhookUrl('https://evil.example.com/api/webhooks/123/abc'), false);
    assert.strictEqual(isValidDiscordWebhookUrl('http://discord.com/api/webhooks/123456/abcdef'), false);
    assert.strictEqual(isValidDiscordWebhookUrl('YOUR_WEBHOOK_URL_HERE'), false);
    assert.strictEqual(isValidDiscordWebhookUrl(undefined), false);
});
