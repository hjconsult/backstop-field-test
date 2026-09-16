const test = require('node:test');
const assert = require('node:assert');
const pricing = require('../src/pricing');
test('pricing multiplies by 100', () => { assert.equal(pricing(2), 200); });
