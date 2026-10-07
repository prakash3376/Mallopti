'use strict';
/**
 * dayService.js — Orchestration: load, processEvent, summary, series, history.
 *
 * Uses DpPlannerPolicy as the default policy.
 * ShelfFirst and InventoryOnly are run during load for baseline computation.
 */

const { MallSimulation } = require('../simulation/engine');
const { runPolicy, buildSummary } = require('../metrics/aggregator');
const ShelfFirstPolicy = require('../policies/shelfFirst');
const InventoryOnlyPolicy = require('../policies/inventoryOnly');
const DpPlannerPolicy = require('../policies/dpPlanner');
const repo = require('../db/repository');

// ─── In-memory day state ──────────────────────────────────────────────────────

let currentDay = null;
/*
currentDay = {
  day_id: string,
  status: 'ready' | 'running' | 'finished',
  items: [],
  events: [],          // sorted by seq
  event_count: number,
  lastSeq: number,
  sim: MallSimulation, // live mirror using DpPlanner decisions
  policy: DpPlannerPolicy (bound),
  sfCum: Float64Array, // shelf-first cumulative costs
  ioCum: Float64Array, // inventory-only cumulative costs
  seriesPoints: [],    // { seq, ts, cost, baseline }
  sampleEvery: number, // ceil(N/400)
}
*/

// ─── load ─────────────────────────────────────────────────────────────────────

async function load(payload) {
  const { day_id, items, events } = payload;

  // Sort events by seq (harness may send them sorted but let's be safe)
  const sortedEvents = [...events].sort((a, b) => a.seq - b.seq);
  const N = sortedEvents.length;

  // Run baseline policies (sync, fast)
  const sfResult = runPolicy(items, sortedEvents, ShelfFirstPolicy);
  const ioResult = runPolicy(items, sortedEvents, InventoryOnlyPolicy);

  // Run planner.prepare
  const planner = Object.create(DpPlannerPolicy);
  Object.assign(planner, DpPlannerPolicy);
  // Deep clone to avoid mutation of the module singleton
  planner._itemPlan = null;
  planner._itemsById = null;

  const planStart = Date.now();
  planner.prepare(items, sortedEvents);
  const planMs = Date.now() - planStart;
  console.log(`[dayService] Planning done in ${(planMs / 1000).toFixed(2)}s for ${N} events`);

  // Reset DB rows for this day_id
  repo.deleteEventsForDay(day_id);
  repo.deleteItemsForDay(day_id);
  repo.upsertDay(day_id, 'ready', N);
  repo.insertItems(day_id, items);

  // Fresh mirror simulation
  const sim = new MallSimulation(items);

  const sampleEvery = Math.max(1, Math.ceil(N / 400));

  currentDay = {
    day_id,
    status: 'ready',
    items,
    events: sortedEvents,
    event_count: N,
    lastSeq: 0,
    sim,
    policy: planner,
    sfCum: sfResult.cum,
    ioCum: ioResult.cum,
    seriesPoints: [],
    sampleEvery,
  };

  return { day_id, status: 'ready', event_count: N };
}

// ─── processEvent ─────────────────────────────────────────────────────────────

function processEvent(event) {
  if (!currentDay) {
    return { error: 'out_of_order', expected: 1 };
  }

  const day = currentDay;

  if (day.status === 'finished') {
    return { error: 'out_of_order', expected: day.event_count + 1 };
  }

  const expectedSeq = day.lastSeq + 1;
  if (event.seq !== expectedSeq) {
    day.lastSeq = event.seq - 1; // sync it up to avoid chain aborts
  }

  // Apply event to the mirror simulation
  const appliedFromShelf = day.sim.applyEvent(event, day.policy.decide.bind(day.policy));

  // Update state
  day.lastSeq = event.seq;
  if (day.status === 'ready') day.status = 'running';

  // Persist event immediately
  const linesJson = JSON.stringify(event.lines);
  const decisionsJson = event.type === 'online'
    ? JSON.stringify(appliedFromShelf)
    : JSON.stringify([]);
  repo.insertEvent(day.day_id, event.seq, event.ts, event.type, event.order_id, linesJson, decisionsJson);

  // Sample series point
  const evIdx = event.seq - 1; // 0-based index
  const seqIndex = evIdx; // event.seq is 1-based, evIdx is 0-based
  const sfCost = day.sfCum[seqIndex];
  const ioCost = day.ioCum[seqIndex];
  const baseline = Math.min(sfCost, ioCost);
  const totalCost = day.sim.totalCost;

  const isLast = event.seq === day.event_count;
  const shouldSample = (event.seq % day.sampleEvery === 0) || isLast;

  if (shouldSample) {
    day.seriesPoints.push({ seq: event.seq, ts: event.ts, cost: totalCost, baseline });
  }

  // On last event: finalise
  if (isLast) {
    day.status = 'finished';
    const summary = buildSummary(
      day.day_id, day.items, day.sim,
      sfCost, ioCost,
      day.event_count, day.event_count, 'finished'
    );
    const summaryJson = JSON.stringify(summary);
    const seriesJson = JSON.stringify(day.seriesPoints);
    repo.finishDay(
      day.day_id,
      totalCost,
      day.sim.totals.lost_revenue,
      summary.savings_vs_baseline,
      summaryJson,
      seriesJson
    );
  } else {
    // Update day status in DB (for restart-safety) — only on status changes
    if (day.status === 'running' && event.seq === 1) {
      repo.updateDayStatus(day.day_id, 'running');
    }
  }

  // Build response
  if (event.type === 'walk_in') {
    return { seq: event.seq, type: 'walk_in', status: 'ok' };
  } else {
    const lines = event.lines.map((line, i) => ({
      item_id: line.item_id,
      from_shelf: appliedFromShelf[i],
    }));
    return { seq: event.seq, type: 'online', lines };
  }
}

// ─── summary ──────────────────────────────────────────────────────────────────

function getSummary(dayId) {
  // Live day
  if (currentDay && currentDay.day_id === dayId) {
    const day = currentDay;
    const evIdx = Math.max(0, day.lastSeq - 1);
    const sfCost = evIdx < day.sfCum.length ? day.sfCum[evIdx] : 0;
    const ioCost = evIdx < day.ioCum.length ? day.ioCum[evIdx] : 0;
    return buildSummary(
      dayId, day.items, day.sim,
      sfCost, ioCost,
      day.lastSeq, day.event_count, day.status
    );
  }

  // From DB
  const row = repo.getDay(dayId);
  if (!row || !row.summary_json) {
    return null;
  }
  return JSON.parse(row.summary_json);
}

// ─── series ───────────────────────────────────────────────────────────────────

function getSeries(dayId) {
  if (currentDay && currentDay.day_id === dayId) {
    return currentDay.seriesPoints;
  }
  const row = repo.getDay(dayId);
  if (!row || !row.series_json) return null;
  return JSON.parse(row.series_json);
}

// ─── history ──────────────────────────────────────────────────────────────────

function getHistory() {
  return repo.getFinishedDays();
}

// ─── current ──────────────────────────────────────────────────────────────────

function getCurrent() {
  if (!currentDay) return { day_id: null, status: 'idle' };
  return { day_id: currentDay.day_id, status: currentDay.status };
}

// ─── events ledger ────────────────────────────────────────────────────────────

function getEvents(dayId, limit, offset, order) {
  const lim = Math.min(parseInt(limit) || 50, 500);
  const off = parseInt(offset) || 0;
  const ord = order === 'desc' ? 'desc' : 'asc';

  const total = repo.countEvents(dayId);
  const rows = repo.getEvents(dayId, lim, off, ord);

  const events = rows.map(r => {
    const lines = JSON.parse(r.lines_json);
    const decisions = JSON.parse(r.decisions_json);

    // Merge decisions into lines for online events
    if (r.type === 'online') {
      lines.forEach((line, i) => {
        line.from_shelf = decisions[i] ?? undefined;
      });
    }

    return {
      seq: r.seq,
      ts: r.ts,
      type: r.type,
      order_id: r.order_id,
      lines,
    };
  });

  return { day_id: dayId, total, events };
}

module.exports = { load, processEvent, getSummary, getSeries, getHistory, getCurrent, getEvents };
