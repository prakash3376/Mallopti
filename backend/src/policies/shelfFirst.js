'use strict';
/**
 * shelfFirst.js — Shelf-First baseline policy (spec §2.9)
 * from_shelf = min(qty, S)
 */

const ShelfFirstPolicy = {
  name: 'shelf_first',

  prepare(_items, _events) {
    // No planning needed
  },

  decide(_event, lineIndex, S) {
    const qty = _event.lines[lineIndex].qty;
    return Math.min(qty, S);
  },
};

module.exports = ShelfFirstPolicy;
