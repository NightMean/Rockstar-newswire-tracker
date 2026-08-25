const { test } = require('node:test');
const assert = require('node:assert');
const { escapeHtml } = require('../src/utils');

test('escapeHtml escapes all HTML-special characters', () => {
    assert.strictEqual(
        escapeHtml(`<script>alert("xss")</script>`),
        '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
});

test('escapeHtml escapes ampersands, quotes and apostrophes', () => {
    assert.strictEqual(escapeHtml('&'), '&amp;');
    assert.strictEqual(escapeHtml('"'), '&quot;');
    assert.strictEqual(escapeHtml("'"), '&#39;');
});

test('escapeHtml leaves plain text untouched', () => {
    assert.strictEqual(escapeHtml('Grand Theft Auto VI Trailer 2'), 'Grand Theft Auto VI Trailer 2');
});

test('escapeHtml does not double-encode already-escaped entities it produces', () => {
    // & is escaped first, so a literal "<" becomes &lt; and stays that way
    assert.strictEqual(escapeHtml('<'), '&lt;');
    assert.strictEqual(escapeHtml('a & b < c'), 'a &amp; b &lt; c');
});

test('escapeHtml coerces non-string values', () => {
    assert.strictEqual(escapeHtml(123), '123');
    assert.strictEqual(escapeHtml(null), 'null');
});
