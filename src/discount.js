const pricing = require('./pricing');
module.exports = (n, percent) => pricing(n) * (1 - percent / 100);
