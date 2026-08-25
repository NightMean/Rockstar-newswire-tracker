const { test } = require('node:test');
const assert = require('node:assert');
const { formatDate } = require('../src/newswire');

// Fixed date to avoid timezone flakiness: 2024-03-05T12:00:00Z, local-safe parts
const d = new Date(2024, 2, 5); // 5 March 2024, local time

test('formatDate supports DD/MM/YYYY', () => {
    assert.strictEqual(formatDate(d, 'DD/MM/YYYY'), '05/03/2024');
});

test('formatDate supports MM/DD/YYYY', () => {
    assert.strictEqual(formatDate(d, 'MM/DD/YYYY'), '03/05/2024');
});

test('formatDate defaults to DD/MM/YYYY for unknown formats', () => {
    assert.strictEqual(formatDate(d, undefined), '05/03/2024');
    assert.strictEqual(formatDate(d, 'YYYY-MM-DD'), '05/03/2024');
});

test('formatDate pads single-digit day and month', () => {
    const jan = new Date(2024, 0, 9);
    assert.strictEqual(formatDate(jan, 'DD/MM/YYYY'), '09/01/2024');
});

test('formatDate falls back to the raw input for invalid dates', () => {
    assert.strictEqual(formatDate('not-a-date', 'DD/MM/YYYY'), 'not-a-date');
});
