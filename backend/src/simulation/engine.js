'use strict';

/**
 * engine.js — Single source of truth for Mall simulation rules (spec §2).
 *
 * Two exports:
 *   stepLine(item, S, kind, qty, rawFromShelf, out)  — pure single-line transition
 *   MallSimulation                                    — stateful day simulation
 */

// ---------------------------------------------------------------------------
// Refill threshold (ONE place in the entire codebase)
// ---------------------------------------------------------------------------
const REFILL_THRESHOLD = 0; // S == 0 triggers a refill (spec §2.6)

/**
 * stepLine — pure single-line state transition. Writes results into `out`.
 *
 * @param {object} item  - { unit_price_paise, initial_shelf_qty, refill_cost_per_unit_paise, online_pull_cost_per_unit_paise }
 * @param {number} S     - current shelf quantity (integer)
 * @param {string} kind  - 'walk_in' or 'online'
 * @param {number} qty   - requested quantity (integer >= 1)
 * @param {*}      rawFromShelf - raw from_shelf value for online (any type)
 * @param {object} out   - result object (mutated in place)
 *
 * out fields set:
 *   refill (bool), pull (bool), lost (bool),
 *   unitsLost, unitsPulled, walkRev, onRev,
 *   refillCount, applied, clamped, S (new shelf value), cost
 */
function stepLine(item, S, kind, qty, rawFromShelf, out) {
  const {
    unit_price_paise: price,
    initial_shelf_qty: K,
    refill_cost_per_unit_paise: refillCPU,
    online_pull_cost_per_unit_paise: pullCPU,
  } = item;

  // Reset output
  out.refill = false;
  out.pull = false;
  out.lost = false;
  out.unitsLost = 0;
  out.unitsPulled = 0;
  out.walkRev = 0;
  out.onRev = 0;
  out.refillCount = 0;
  out.applied = 0;
  out.clamped = false;
  out.cost = 0;

  let newS = S;

  if (kind === 'walk_in') {
    // Spec §2.4: whole-line lost if qty > S, S unchanged
    if (qty <= S) {
      newS = S - qty;
      out.walkRev = qty * price;
    } else {
      out.lost = true;
      out.unitsLost = qty;
      // S unchanged — newS remains = S
      // lost_revenue is part of TotalCost — include in out.cost so DP can account for it
      out.cost = qty * price;
    }
  } else {
    // Online — spec §2.5
    // Match harness clamping: missing/null/non-integer → treated as 0 for harness raw;
    // negative integers stay as-is for clamping comparison (harness keeps the negative value).
    // clamped = (applied != harness_raw_after_type_normalisation)
    let harnessRaw; // what the harness uses as raw_fs before clamp
    if (rawFromShelf === null || rawFromShelf === undefined || typeof rawFromShelf === 'string') {
      harnessRaw = 0;
    } else if (!Number.isInteger(rawFromShelf)) {
      // non-integer float: spec says treat as 0; harness does int() which truncates
      harnessRaw = 0;
    } else {
      harnessRaw = rawFromShelf; // includes negatives
    }

    const maxShelf = Math.min(qty, S);
    // clamp to [0, maxShelf]
    const applied = Math.max(0, Math.min(harnessRaw, maxShelf));
    out.applied = applied;
    out.clamped = (applied !== harnessRaw);

    const inventoryUnits = qty - applied;
    newS = S - applied;

    out.pull = inventoryUnits > 0;
    out.unitsPulled = inventoryUnits;
    out.onRev = qty * price;
    out.cost = inventoryUnits * pullCPU;
  }

  // Refill rule (spec §2.6) — applied after EVERY line
  if (newS === REFILL_THRESHOLD) {
    out.refill = true;
    out.refillCount = 1;
    const refillCost = K * refillCPU;
    out.cost += refillCost;
    newS = K;
  }

  out.S = newS;
  return out;
}

// ---------------------------------------------------------------------------
// MallSimulation — stateful simulation for one day
// ---------------------------------------------------------------------------

class MallSimulation {
  /**
   * @param {Array<object>} items - array of item parameter objects
   */
  constructor(items) {
    // Shelf state: item_id -> current shelf qty
    this.shelf = {};

    // Per-item stats
    this.itemStats = {};

    // Build lookup
    this._items = {};
    for (const item of items) {
      const id = item.item_id;
      this._items[id] = item;
      this.shelf[id] = item.initial_shelf_qty;
      this.itemStats[id] = {
        refill_count: 0,
        units_lost: 0,
        lost_revenue: 0,
        units_pulled: 0,
        pull_cost: 0,
        refill_cost: 0,
      };
    }

    // Day totals
    this.totals = {
      refill_cost: 0,
      online_pull_cost: 0,
      lost_revenue: 0,
      refill_count: 0,
      units_lost: 0,
      units_pulled_from_inventory: 0,
      walk_in_revenue_captured: 0,
      online_revenue: 0,
    };

    // Count of lines where our returned from_shelf was clamped by the harness
    this.clampedLines = 0;

    // Reusable out object
    this._out = {};
  }

  /**
   * Apply a single event using the policy's decide function.
   *
   * @param {object} event  - the event object { type, lines, ... }
   * @param {function} decide - (event, lineIndex, S) => desired from_shelf
   * @returns {Array<number>} appliedFromShelf values for online events (empty for walk_in)
   */
  applyEvent(event, decide) {
    const applied = [];
    const out = this._out;

    for (let i = 0; i < event.lines.length; i++) {
      const line = event.lines[i];
      const id = line.item_id;
      const item = this._items[id];
      const S = this.shelf[id];

      let rawFromShelf;
      if (event.type === 'online') {
        rawFromShelf = decide(event, i, S);
      } else {
        rawFromShelf = undefined;
      }

      stepLine(item, S, event.type, line.qty, rawFromShelf, out);

      // Update shelf
      this.shelf[id] = out.S;

      // Update per-item stats
      const stats = this.itemStats[id];
      if (out.refill) {
        const refillCost = item.initial_shelf_qty * item.refill_cost_per_unit_paise;
        stats.refill_count += out.refillCount;
        stats.refill_cost += refillCost;
        this.totals.refill_cost += refillCost;
        this.totals.refill_count += out.refillCount;
      }

      if (out.lost) {
        const lostRev = out.unitsLost * item.unit_price_paise;
        stats.units_lost += out.unitsLost;
        stats.lost_revenue += lostRev;
        this.totals.units_lost += out.unitsLost;
        this.totals.lost_revenue += lostRev;
      }

      if (event.type === 'walk_in' && !out.lost) {
        this.totals.walk_in_revenue_captured += out.walkRev;
      }

      if (event.type === 'online') {
        const pullCost = out.unitsPulled * item.online_pull_cost_per_unit_paise;
        stats.units_pulled += out.unitsPulled;
        stats.pull_cost += pullCost;
        this.totals.units_pulled_from_inventory += out.unitsPulled;
        this.totals.online_pull_cost += pullCost;
        this.totals.online_revenue += out.onRev;

        if (out.clamped) this.clampedLines++;
        applied.push(out.applied);
      }
    }

    return applied;
  }

  get totalCost() {
    return this.totals.refill_cost + this.totals.online_pull_cost + this.totals.lost_revenue;
  }

  get grossRevenue() {
    return this.totals.walk_in_revenue_captured + this.totals.online_revenue;
  }
}

module.exports = { stepLine, MallSimulation, REFILL_THRESHOLD };
