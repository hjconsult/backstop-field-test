const test = require('node:test');
const assert = require('node:assert');
const discount = require('../src/discount');
test('discount applies a percentage to the priced amount', () => {
  assert.equal(discount(2, 10), 180);
});
