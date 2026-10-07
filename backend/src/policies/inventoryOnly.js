'use strict';
/**
 * inventoryOnly.js — Inventory-Only baseline policy (spec §2.9)
 * from_shelf = 0 for every online line
 */

const InventoryOnlyPolicy = {
  name: 'inventory_only',

  prepare(_items, _events) {
    // No planning needed
  },

  decide(_event, _lineIndex, _S) {
    return 0;
  },
};

module.exports = InventoryOnlyPolicy;
