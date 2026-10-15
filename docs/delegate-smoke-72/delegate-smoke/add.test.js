const test = require('node:test');
const assert = require('node:assert/strict');
const { add } = require('./add');

test('add should return the sum of two positive numbers', () => {
  assert.strictEqual(add(2, 3), 5);
});

test('add should return the sum of positive and negative numbers', () => {
  assert.strictEqual(add(5, -2), 3);
});

test('add should return zero when summing opposite numbers', () => {
  assert.strictEqual(add(-4, 4), 0);
});

test('add should handle zeroes correctly', () => {
  assert.strictEqual(add(0, 0), 0);
  assert.strictEqual(add(0, 7), 7);
  assert.strictEqual(add(7, 0), 7);
});

test('add should handle floating point numbers', () => {
  assert.strictEqual(add(1.5, 2.5), 4);
});
