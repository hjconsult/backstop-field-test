const discount = require('./discount');

// Sum a cart at a single promotional rate. Imports discount, which is owned
// by the add-discount task, so this should produce a real lineage edge.
module.exports = (items, percent) =>
  items.reduce((total, qty) => total + discount(qty, percent), 0);
