'use strict';
/**
 * aggregator.js — Metrics computation (spec §4.1.5)
 *
 * runPolicy(items, events, policy) -> { sim, cum }
 * buildSummary(dayId, items, sim, sfSim, ioSim, eventsProcessed, eventsTotal, status) -> summary JSON
 */

const { MallSimulation } = require('../simulation/engine');

/**
 * Run a policy over events and return { sim, cum }
 * cum[i] = cumulative total cost after processing events[0..i]
 *
 * @param {Array} items
 * @param {Array} events - sorted by seq
 * @param {object} policy - { name, prepare, decide }
 * @returns {{ sim: MallSimulation, cum: Float64Array }}
 */
function runPolicy(items, events, policy) {
  const sim = new MallSimulation(items);
  const n = events.length;
  const cum = new Float64Array(n);

  const decide = policy.decide.bind(policy);

  for (let i = 0; i < n; i++) {
    sim.applyEvent(events[i], decide);
    cum[i] = sim.totalCost;
  }

  return { sim, cum };
}

/**
 * Build the summary JSON as per spec §4.1.5.
 *
 * @param {string} dayId
 * @param {Array}  items       - item parameter objects
 * @param {MallSimulation} sim - the DP/active simulation
 * @param {number} sfCost      - shelf-first cumulative cost at current progress
 * @param {number} ioCost      - inventory-only cumulative cost at current progress
 * @param {number} eventsProcessed
 * @param {number} eventsTotal
 * @param {string} status
 * @returns {object} summary
 */
function buildSummary(dayId, items, sim, sfCost, ioCost, eventsProcessed, eventsTotal, status) {
  const totals = sim.totals;
  const totalCost = sim.totalCost;
  const grossRevenue = sim.grossRevenue;

  const baselineTotalCost = Math.min(sfCost, ioCost);
  const savingsVsBaseline = baselineTotalCost - totalCost;

  const itemRows = items.map(item => {
    const id = item.item_id;
    const stats = sim.itemStats[id] || {};
    return {
      item_id: id,
      name: item.name,
      shelf_qty: sim.shelf[id] ?? item.initial_shelf_qty,
      refill_count: stats.refill_count || 0,
      units_lost: stats.units_lost || 0,
      lost_revenue: stats.lost_revenue || 0,
      units_pulled: stats.units_pulled || 0,
      pull_cost: stats.pull_cost || 0,
      refill_cost: stats.refill_cost || 0,
    };
  });

  return {
    day_id: dayId,
    status,
    events_processed: eventsProcessed,
    events_total: eventsTotal,
    totals: {
      refill_cost: totals.refill_cost,
      online_pull_cost: totals.online_pull_cost,
      lost_revenue: totals.lost_revenue,
      total_cost: totalCost,
      refill_count: totals.refill_count,
      units_lost: totals.units_lost,
      units_pulled_from_inventory: totals.units_pulled_from_inventory,
      walk_in_revenue_captured: totals.walk_in_revenue_captured,
      online_revenue: totals.online_revenue,
      gross_revenue: grossRevenue,
    },
    baseline: {
      shelf_first_cost: sfCost,
      inventory_only_cost: ioCost,
      total_cost: baselineTotalCost,
    },
    savings_vs_baseline: savingsVsBaseline,
    items: itemRows,
  };
}

module.exports = { runPolicy, buildSummary };
