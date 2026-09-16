const test = require('node:test');
const assert = require('node:assert');
const cart = require('../src/cart');

test('cart totals every line at the same discount', () => {
  assert.equal(cart([2, 1], 10), 270);
});
