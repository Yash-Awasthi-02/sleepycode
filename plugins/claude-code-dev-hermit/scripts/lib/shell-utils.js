'use strict';

function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

module.exports = { shellQuote };
