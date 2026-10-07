'use strict';
/**
 * repository.js — In-memory mock for local testing.
 * Replaces better-sqlite3 because native bindings fail on some local environments.
 */

const days = new Map();
const eventsByDay = new Map();
const itemsMap = new Map();

// ─── Days ────────────────────────────────────────────────────────────────────

function upsertDay(dayId, status, eventCount) {
  const existing = days.get(dayId) || {};
  days.set(dayId, {
    day_id: dayId,
    status: status,
    event_count: eventCount,
    total_cost: existing.total_cost || 0,
    lost_revenue: existing.lost_revenue || 0,
    savings_vs_baseline: existing.savings_vs_baseline || 0,
    summary_json: null,
    series_json: null
  });
}

function updateDayStatus(dayId, status) {
  const d = days.get(dayId);
  if (d) d.status = status;
}

function finishDay(dayId, totalCost, lostRevenue, savingsVsBaseline, summaryJson, seriesJson) {
  const d = days.get(dayId);
  if (d) {
    d.status = 'finished';
    d.total_cost = totalCost;
    d.lost_revenue = lostRevenue;
    d.savings_vs_baseline = savingsVsBaseline;
    d.summary_json = summaryJson;
    d.series_json = seriesJson;
  }
}

function getDay(dayId) {
  return days.get(dayId);
}

function getFinishedDays() {
  const res = [];
  for (const d of days.values()) {
    if (d.status === 'finished') {
      res.push({ day_id: d.day_id, total_cost: d.total_cost, lost_revenue: d.lost_revenue, savings_vs_baseline: d.savings_vs_baseline });
    }
  }
  return res;
}

// ─── Events ──────────────────────────────────────────────────────────────────

function deleteEventsForDay(dayId) {
  eventsByDay.delete(dayId);
}

function insertEvent(dayId, seq, ts, type, orderId, linesJson, decisionsJson) {
  let evs = eventsByDay.get(dayId);
  if (!evs) {
    evs = [];
    eventsByDay.set(dayId, evs);
  }
  evs.push({ day_id: dayId, seq, ts, type, order_id: orderId, lines_json: linesJson, decisions_json: decisionsJson });
}

function insertEventsBatch(rows) {
  if (rows.length === 0) return;
  const dayId = rows[0].dayId;
  let evs = eventsByDay.get(dayId);
  if (!evs) {
    evs = [];
    eventsByDay.set(dayId, evs);
  }
  for (const r of rows) {
    evs.push({ day_id: r.dayId, seq: r.seq, ts: r.ts, type: r.type, order_id: r.orderId, lines_json: r.linesJson, decisions_json: r.decisionsJson });
  }
}

function getEvents(dayId, limit, offset, order) {
  let dayEvents = eventsByDay.get(dayId) || [];
  if (order === 'desc') {
    dayEvents = [...dayEvents].sort((a, b) => b.seq - a.seq);
  }
  return dayEvents.slice(offset, offset + limit);
}

function countEvents(dayId) {
  return (eventsByDay.get(dayId) || []).length;
}

// ─── Items ───────────────────────────────────────────────────────────────────

function deleteItemsForDay(dayId) {
  for (const [k, v] of itemsMap.entries()) {
    if (v.day_id === dayId) itemsMap.delete(k);
  }
}

function insertItems(dayId, items) {
  for (const it of items) {
    itemsMap.set(it.item_id, { ...it, day_id: dayId });
  }
}

module.exports = {
  upsertDay,
  updateDayStatus,
  finishDay,
  getDay,
  getFinishedDays,
  deleteEventsForDay,
  insertEvent,
  insertEventsBatch,
  getEvents,
  countEvents,
  deleteItemsForDay,
  insertItems,
};
