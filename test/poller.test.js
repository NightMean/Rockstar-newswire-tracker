const { test } = require('node:test');
const assert = require('node:assert');
const { NewswirePoller } = require('../src/poller');

// ---- fakes ----------------------------------------------------------------

function makeStore(seen = {}) {
    return {
        seen,
        whenLoaded: async () => { },
        has: (id) => Boolean(seen[id]),
        markSeen(id, url) { this.seen[id] = url; }
    };
}

function makeNotifier(delivered) {
    const calls = [];
    return {
        calls,
        send: async (article) => { calls.push(article.id); return delivered; }
    };
}

function makeApi({ listResponses, article } = {}) {
    const responses = [...(listResponses || [])];
    const state = { fetchListCalls: 0 };
    return {
        state,
        fetchList: async () => {
            state.fetchListCalls += 1;
            const next = responses.shift();
            if (next instanceof Error) throw next;
            return next ?? {};
        },
        fetchArticle: async () => article ?? null
    };
}

const PERSISTED_QUERY_NOT_FOUND_RESPONSE = {
    data: null,
    errors: [{ message: 'PersistedQueryNotFound' }]
};

function makePost(id, url = `/article-${id}`) {
    return {
        id,
        title: `Title ${id}`,
        url,
        created: '2026-08-06T08:00:00Z',
        primary_tags: [{ name: 'tag' }],
        preview_images_parsed: { newswire_block: { d16x9: `https://img/${id}.png` } }
    };
}

function makePoller({ store = makeStore(), notifier = makeNotifier(true), api, rssItems = [], ...options } = {}) {
    let hashRefreshes = 0;
    const poller = new NewswirePoller({
        genre: 'latest',
        tagId: null,
        store,
        notifier,
        onRSSUpdate: (items) => rssItems.push(items),
        options: {
            autoStart: false,
            rateLimitDelayMs: 0,
            api: api || makeApi(),
            acquireHash: async () => `hash-${++hashRefreshes}`,
            ...options
        }
    });
    return poller;
}

// ---- tests ----------------------------------------------------------------

test('getNewArticles maps unseen posts and enriches the subtitle', async () => {
    const api = makeApi({
        listResponses: [{ data: { posts: { results: [makePost('a'), makePost('b')] } } }],
        article: { tina: { payload: { meta: { subtitle: 'The subtitle' } } } }
    });
    const poller = makePoller({ api });

    const articles = await poller.getNewArticles();
    assert.strictEqual(articles.length, 2);
    assert.deepStrictEqual(articles[0], {
        id: 'a',
        title: 'Title a',
        link: 'https://www.rockstargames.com/article-a',
        img: 'https://img/a.png',
        date: '2026-08-06T08:00:00Z',
        tags: ['tag'],
        subtitle: 'The subtitle'
    });
});

test('getNewArticles skips articles already marked seen', async () => {
    const api = makeApi({
        listResponses: [{ data: { posts: { results: [makePost('seen'), makePost('fresh')] } } }]
    });
    const poller = makePoller({ api, store: makeStore({ seen: true }) });

    const articles = await poller.getNewArticles();
    assert.strictEqual(articles.length, 1);
    assert.strictEqual(articles[0].id, 'fresh');
});

test('getNewArticles checks at most checkLimit posts', async () => {
    const api = makeApi({
        listResponses: [{ data: { posts: { results: [makePost('1'), makePost('2'), makePost('3')] } } }]
    });
    const poller = makePoller({ api, checkLimit: 2 });

    const articles = await poller.getNewArticles();
    assert.strictEqual(articles.length, 2);
});

test('processNewArticles marks seen only after successful delivery', async () => {
    const store = makeStore();
    const notifier = makeNotifier(true);
    const poller = makePoller({ store, notifier });

    await poller.processNewArticles([
        { id: 'new1', title: 't', link: 'l', tags: [] },
        { id: 'new2', title: 't', link: 'l', tags: [] }
    ]);

    assert.deepStrictEqual(notifier.calls, ['new2', 'new1']); // oldest first
    assert.ok(store.seen.new1 && store.seen.new2);
});

test('failed delivery leaves the article unseen so it is retried', async () => {
    const store = makeStore();
    const poller = makePoller({ store, notifier: makeNotifier(false) });

    await poller.processNewArticles([{ id: 'fail1', title: 't', link: 'l', tags: [] }]);

    assert.deepStrictEqual(Object.keys(store.seen), []);
});

test('requestListWithTokenRefresh refreshes the hash and retries once on expiry', async () => {
    const api = makeApi({
        listResponses: [
            PERSISTED_QUERY_NOT_FOUND_RESPONSE,
            { data: { posts: { results: [makePost('ok')] } } }
        ]
    });
    const poller = makePoller({ api, store: makeStore({ ok: true }) });

    const res = await poller.requestListWithTokenRefresh();

    assert.strictEqual(api.state.fetchListCalls, 2);
    assert.strictEqual(poller.hash, 'hash-1');
    assert.strictEqual(res.data.posts.results[0].id, 'ok');
});

test('updateRSS reports an empty batch through onRSSUpdate when the API fails', async () => {
    const api = makeApi({ listResponses: [PERSISTED_QUERY_NOT_FOUND_RESPONSE] });
    // Second refresh attempt also fails -> null response
    api.fetchList = async () => { throw new Error('network down'); };
    const rssItems = [];
    const poller = makePoller({ api, rssItems });

    const items = await poller.updateRSS();

    assert.deepStrictEqual(items, []);
    assert.strictEqual(rssItems.length, 1);
    assert.deepStrictEqual(rssItems[0], []);
});

test('tick skips while a previous refresh is still running', async () => {
    let fetchCalls = 0;
    const api = makeApi();
    api.fetchList = async () => { fetchCalls += 1; return { data: { posts: { results: [] } } }; };
    const poller = makePoller({ api });

    poller.isRefreshing = true; // simulate an in-flight refresh
    await poller.tick();

    assert.strictEqual(fetchCalls, 0); // tick bailed out before fetching
    assert.strictEqual(poller.isRefreshing, true); // flag untouched by the skipped tick
});

test('tick resets the refreshing flag even when a cycle throws', async () => {
    const api = makeApi();
    api.fetchList = async () => { throw new Error('boom'); };
    const poller = makePoller({ api });

    await poller.tick();

    assert.strictEqual(poller.isRefreshing, false);
});
