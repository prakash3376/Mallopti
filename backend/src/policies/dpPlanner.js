'use strict';
/**
 * dpPlanner.js — Exact per-item DP policy (spec §7 R1, R3)
 *
 * Items are independent. For each item, we build the FULL ordered sequence of
 * lines that touch it (walk_in lines are deterministic; online lines are choices).
 *
 * State:  s ∈ {1..K}  (shelf qty before processing line t)
 *         (s=0 never occurs at line-start because refill is immediate)
 * V[t][s] = minimum total cost from line t onward, starting with shelf qty s.
 *
 * Backward DP with two rolling Float64Array rows + a Uint8Array decision table.
 * Ties broken by strictly-less comparison, so the smallest x wins.
 *
 * Forward pass from s=K records plan[t] for every line.
 * decide() reads the plan sequentially per item, safety-clamped to S.
 *
 * All transitions call engine.stepLine (no duplicated rules).
 */

const { stepLine } = require('../simulation/engine');

const DpPlannerPolicy = {
  name: 'dp_planner',

  // _itemPlan[item_id] = { plan: Int32Array of from_shelf (−1 for walk_in), onlineIdx: number }
  _itemPlan: null,
  _itemsById: null,

  prepare(items, events) {
    this._itemPlan = {};
    this._itemsById = {};

    for (const item of items) {
      this._itemsById[item.item_id] = item;
    }

    // Build per-item full line sequences in seq order
    // allLinesPerItem[item_id] = [ { type, qty }, ... ]
    const allLinesPerItem = {};
    for (const item of items) {
      allLinesPerItem[item.item_id] = [];
    }

    // events are sorted by seq before prepare is called
    for (const ev of events) {
      for (const line of ev.lines) {
        allLinesPerItem[line.item_id].push({ type: ev.type, qty: line.qty });
      }
    }

    // Solve each item independently
    for (const item of items) {
      const id = item.item_id;
      const lines = allLinesPerItem[id];
      const plan = this._solveItem(item, lines);
      this._itemPlan[id] = { plan, onlineIdx: 0 };
    }
  },

  /**
   * Solve one item via exact backward DP.
   *
   * @param {object} item  - item parameters
   * @param {Array}  lines - [ {type, qty}, ... ] in event seq order
   * @returns {Int32Array} plan[t] = optimal from_shelf for line t (−1 for walk_in)
   */
  _solveItem(item, lines) {
    const n = lines.length;
    const K = item.initial_shelf_qty;
    const plan = new Int32Array(n).fill(-1);

    if (n === 0) return plan;

    // V[s] for s=1..K; index 0 unused
    // Use Float64Array for large paise values
    const INF = 1e18;
    let curr = new Float64Array(K + 1).fill(INF);
    let nxt = new Float64Array(K + 1).fill(0); // after last line, cost=0
    // Pre-fill nxt with 0 for all valid s (base case)
    for (let s = 1; s <= K; s++) nxt[s] = 0;

    // Decision table: flat array, indexed [t * (K+1) + s]
    // Uint8 is fine: max x ≤ min(15, K) ≤ 15 (online qty ≤ 15 per spec §6)
    const decTable = new Uint8Array(n * (K + 1));

    const out = {};

    // Backward pass: t = n-1 down to 0
    for (let t = n - 1; t >= 0; t--) {
      const { type, qty } = lines[t];

      if (type === 'walk_in') {
        // No choice — deterministic
        for (let s = 1; s <= K; s++) {
          stepLine(item, s, 'walk_in', qty, undefined, out);
          const lineCost = out.cost;
          const sNext = out.S; // 1..K after refill rule
          curr[s] = lineCost + nxt[sNext];
          // decTable entry stays 0 (no decision)
        }
      } else {
        // Online line — choose x ∈ 0..min(qty,s)
        for (let s = 1; s <= K; s++) {
          const maxX = Math.min(qty, s);
          let bestCost = INF;
          let bestX = 0;

          for (let x = 0; x <= maxX; x++) {
            stepLine(item, s, 'online', qty, x, out);
            const total = out.cost + nxt[out.S];
            // Strict less: ties go to smallest x
            if (total < bestCost) {
              bestCost = total;
              bestX = x;
            }
          }

          curr[s] = bestCost;
          decTable[t * (K + 1) + s] = bestX;
        }
      }

      // Swap rows
      const tmp = nxt;
      nxt = curr;
      curr = tmp;
      curr.fill(INF);
    }
    // nxt[s] = V[0][s]

    // Forward pass from s = K
    let s = K;
    for (let t = 0; t < n; t++) {
      const { type, qty } = lines[t];
      if (type === 'walk_in') {
        stepLine(item, s, 'walk_in', qty, undefined, out);
        s = out.S;
        plan[t] = -1;
      } else {
        const x = decTable[t * (K + 1) + s];
        plan[t] = x;
        stepLine(item, s, 'online', qty, x, out);
        s = out.S;
      }
    }

    return plan;
  },

  /**
   * Called by MallSimulation.applyEvent for each online line.
   * Returns the pre-planned from_shelf value (safety-clamped to S).
   *
   * The planner's decision table was computed for online lines only,
   * so we track a separate onlineIdx per item.
   *
   * @param {object} event
   * @param {number} lineIndex - index into event.lines
   * @param {number} S        - current shelf qty (from mirror simulation)
   * @returns {number} from_shelf
   */
  decide(event, lineIndex, S) {
    const itemId = event.lines[lineIndex].item_id;
    const state = this._itemPlan[itemId];

    if (!state) return 0;

    // Find the next online-line plan entry for this item
    // The plan array covers ALL lines (walk_in = -1, online = x).
    // We iterate to the next online entry.
    const { plan } = state;
    let idx = state.onlineIdx;

    // Advance past walk_in entries (should not happen if we call correctly)
    while (idx < plan.length && plan[idx] === -1) idx++;

    if (idx >= plan.length) {
      state.onlineIdx = idx;
      return 0;
    }

    const x = plan[idx];
    state.onlineIdx = idx + 1;

    // Safety clamp: never exceed current shelf
    return Math.min(x, S);
  },
};

module.exports = DpPlannerPolicy;
