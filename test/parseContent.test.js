const { test } = require('node:test');
const assert = require('node:assert');
const { parseContent } = require('../src/utils');

function postWith(content, extra = {}) {
    return { title: 'Fallback Title', tina: { payload: { content, meta: {} } }, ...extra };
}

test('parseContent returns the title when there is no Tina content', () => {
    assert.strictEqual(parseContent({ title: 'Hello' }), 'Hello');
    assert.strictEqual(parseContent({ title: 'Hello', tina: {} }), 'Hello');
    assert.strictEqual(parseContent({ title: 'Hello', tina: { payload: {} } }), 'Hello');
});

test('parseContent escapes the subtitle', () => {
    const html = parseContent(postWith([], { subtitle: '<script>alert(1)</script>' }));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>'));
});

test('parseContent renders EventInfo images with escaped alt and prefixed src', () => {
    const html = parseContent(postWith([{
        _template: 'EventInfo',
        images: [{ image: { sources: { en_us: { desktop: '/img/a.png' } }, _memoq: { alt: '"onmouseover="x' } } }],
        _memoq: { title: 'Event <Title>' },
        content: []
    }]));
    assert.ok(html.includes('<img src="https://media-rockstargames-com.akamaized.net/img/a.png"'));
    assert.ok(html.includes('alt="&quot;onmouseover=&quot;x"'));
    assert.ok(html.includes('<h2><strong>Event &lt;Title&gt;</strong></h2>'));
});

test('parseContent passes HTMLElement embed markup through unescaped', () => {
    const embed = '<iframe src="https://www.youtube.com/embed/xyz"></iframe>';
    const html = parseContent(postWith([{ _template: 'HTMLElement', _memoq: { content: embed } }]));
    assert.ok(html.includes(embed));
});

test('parseContent traverses Grid containers', () => {
    const html = parseContent(postWith([
        { _template: 'Grid', content: [{ _template: 'HTMLElement', _memoq: { content: '<p>inner</p>' } }] }
    ]));
    assert.ok(html.includes('<p>inner</p>'));
});

test('parseContent fixes double query params in Embed URLs', () => {
    const embed = '<iframe width="640" height="360" src="https://player.vimeo.com/video/1?h=a?autoplay=1"></iframe>';
    const html = parseContent(postWith([{ _template: 'Embed', items: [{ embed }] }]));
    assert.ok(html.includes('src="https://player.vimeo.com/video/1?h=a&autoplay=1"'));
    // Fixed dimensions replaced with responsive styling
    assert.ok(html.includes('width="100%"'));
    assert.ok(html.includes('style="aspect-ratio: 16/9;"'));
});

test('parseContent falls back to the title when traversal yields nothing', () => {
    const html = parseContent(postWith([{ _template: 'RockstarVideoPlayer' }]));
    assert.strictEqual(html, 'Fallback Title');
});
