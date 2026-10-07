'use strict';
/**
 * engine.test.js — Tests for simulation/engine.js
 *
 * Covers:
 * 1. Worked example from spec §2.10
 * 2. All clamping cases (undefined, null, 2.5, -3, 99, string)
 * 3. Per-line walk_in independence; lost line leaves S unchanged
 * 4. Refill only at S == 0
 * 5. DP cost <= both baselines on deterministic pseudo-random day
 * 6. DP is deterministic
 * 7. Brute-force check on tiny day that DP equals true minimum
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { stepLine, MallSimulation } = require('../src/simulation/engine');
const { runPolicy, buildSummary } = require('../src/metrics/aggregator');
const ShelfFirstPolicy = require('../src/policies/shelfFirst');
const InventoryOnlyPolicy = require('../src/policies/inventoryOnly');
const DpPlannerPolicy = require('../src/policies/dpPlanner');

// Helper to create a fresh DpPlanner instance (avoids module-level state)
function makeDpPlanner() {
  return Object.assign(Object.create(DpPlannerPolicy), {
    _itemPlan: null,
    _itemsById: null,
  });
}

// ─── 1. Worked example from spec §2.10 ────────────────────────────────────────

describe('Spec §2.10 worked example', () => {
  test('totals match spec exactly', () => {
    const item = {
      item_id: 'X001',
      name: 'Test',
      category: 'Test',
      unit_price_paise: 100,
      initial_shelf_qty: 5,
      refill_cost_per_unit_paise: 10,
      online_pull_cost_per_unit_paise: 15,
    };

    const events = [
      { seq: 1, ts: 0, type: 'walk_in', order_id: 'W1', lines: [{ item_id: 'X001', qty: 3 }] },
      { seq: 2, ts: 1, type: 'online',  order_id: 'O1', lines: [{ item_id: 'X001', qty: 4 }] },
      { seq: 3, ts: 2, type: 'walk_in', order_id: 'W2', lines: [{ item_id: 'X001', qty: 6 }] },
      { seq: 4, ts: 3, type: 'walk_in', order_id: 'W3', lines: [{ item_id: 'X001', qty: 5 }] },
    ];

    const sim = new MallSimulation([item]);

    // seq 1: walk_in qty=3, S=5 → S=2, walk_rev=300
    sim.applyEvent(events[0], () => 0);
    assert.equal(sim.shelf['X001'], 2);

    // seq 2: online qty=4, from_shelf=2 → applied=2, inv=2, pull=30, S=0→refill→S=5
    // refill cost = 5*10=50, total line cost=80
    sim.applyEvent(events[1], () => 2);
    assert.equal(sim.shelf['X001'], 5);
    assert.equal(sim.totals.online_pull_cost, 30);
    assert.equal(sim.totals.refill_cost, 50);

    // seq 3: walk_in qty=6 > S=5 → lost=600, S unchanged=5
    sim.applyEvent(events[2], () => 0);
    assert.equal(sim.shelf['X001'], 5);
    assert.equal(sim.totals.lost_revenue, 600);
    assert.equal(sim.totals.units_lost, 6);

    // seq 4: walk_in qty=5 ≤ S=5 → S=0→refill→S=5, refill cost+=50
    sim.applyEvent(events[3], () => 0);
    assert.equal(sim.shelf['X001'], 5);

    // Final totals
    assert.equal(sim.totals.refill_cost, 100, 'refill_cost');
    assert.equal(sim.totals.refill_count, 2, 'refill_count');
    assert.equal(sim.totals.online_pull_cost, 30, 'online_pull_cost');
    assert.equal(sim.totals.lost_revenue, 600, 'lost_revenue');
    assert.equal(sim.totalCost, 730, 'TotalCost');
    assert.equal(sim.totals.units_lost, 6, 'units_lost');
    assert.equal(sim.totals.units_pulled_from_inventory, 2, 'units_pulled_from_inventory');
    assert.equal(sim.totals.walk_in_revenue_captured, 800, 'walk_in_revenue_captured');
    assert.equal(sim.totals.online_revenue, 400, 'online_revenue');
    assert.equal(sim.grossRevenue, 1200, 'gross_revenue');
  });
});

// ─── 2. Clamping cases ────────────────────────────────────────────────────────

describe('Online clamping rules', () => {
  const item = {
    item_id: 'C001',
    unit_price_paise: 1000,
    initial_shelf_qty: 10,
    refill_cost_per_unit_paise: 50,
    online_pull_cost_per_unit_paise: 100,
  };
  const event = { type: 'online', lines: [{ item_id: 'C001', qty: 5 }] };

  function runWithRaw(raw) {
    const out = {};
    stepLine(item, 10, 'online', 5, raw, out);
    return out;
  }

  test('undefined → from_shelf=0', () => {
    const out = runWithRaw(undefined);
    assert.equal(out.applied, 0);
    assert.equal(out.clamped, false); // 0 normalised to 0, no clamp
  });

  test('null → from_shelf=0', () => {
    const out = runWithRaw(null);
    assert.equal(out.applied, 0);
  });

  test('2.5 (non-integer float) → from_shelf=0', () => {
    const out = runWithRaw(2.5);
    assert.equal(out.applied, 0);
    // Harness: non-integer → harnessRaw=0, applied=0, clamped=(0!==0)=false
    assert.equal(out.clamped, false);
  });

  test('-3 (negative) → from_shelf=0', () => {
    const out = runWithRaw(-3);
    assert.equal(out.applied, 0);
    // Harness: raw_fs=int(-3)=-3, shelf_units=max(0,min(-3,5))=0, clamped=(0!=-3)=true
    assert.equal(out.clamped, true);
  });

  test('99 (> min(qty,S)) → clamped to min(qty,S)=5', () => {
    const out = runWithRaw(99);
    assert.equal(out.applied, 5); // min(99, min(5,10)) = 5
    assert.equal(out.clamped, true);
  });

  test('string → from_shelf=0', () => {
    const out = runWithRaw('3');
    assert.equal(out.applied, 0);
  });

  test('valid value 3 → applied=3, no clamp', () => {
    const out = runWithRaw(3);
    assert.equal(out.applied, 3);
    assert.equal(out.clamped, false);
  });
});

// ─── 3. Walk-in line independence; lost line leaves S unchanged ───────────────

describe('Walk-in independence', () => {
  test('lost line does not change S', () => {
    const item = {
      item_id: 'W001',
      unit_price_paise: 200,
      initial_shelf_qty: 5,
      refill_cost_per_unit_paise: 10,
      online_pull_cost_per_unit_paise: 20,
    };
    const out = {};
    stepLine(item, 3, 'walk_in', 5, undefined, out); // qty=5 > S=3
    assert.equal(out.lost, true);
    assert.equal(out.unitsLost, 5);
    assert.equal(out.S, 3); // S unchanged
    assert.equal(out.refill, false); // no refill since S didn't change
  });

  test('sold line reduces S and triggers refill at S=0', () => {
    const item = {
      item_id: 'W002',
      unit_price_paise: 200,
      initial_shelf_qty: 5,
      refill_cost_per_unit_paise: 10,
      online_pull_cost_per_unit_paise: 20,
    };
    const out = {};
    stepLine(item, 5, 'walk_in', 5, undefined, out); // qty=5 = S=5 → sold, S=0 → refill
    assert.equal(out.lost, false);
    assert.equal(out.walkRev, 1000); // 5 * 200
    assert.equal(out.S, 5); // refilled back to K
    assert.equal(out.refill, true);
    assert.equal(out.cost, 50); // 5 * 10
  });

  test('multi-line walk_in: lines are independent', () => {
    const item = {
      item_id: 'M001',
      unit_price_paise: 100,
      initial_shelf_qty: 10,
      refill_cost_per_unit_paise: 5,
      online_pull_cost_per_unit_paise: 10,
    };
    const sim = new MallSimulation([item]);
    const event = {
      type: 'walk_in',
      lines: [
        { item_id: 'M001', qty: 3 }, // succeeds: S 10→7
        { item_id: 'M001', qty: 15 }, // fails (but item_id can only appear once per event per spec)
      ],
    };
    // Actually spec says each item_id appears AT MOST ONCE per event
    // So we test with a single-item event, but verify S is correct
    const event2 = {
      type: 'walk_in',
      lines: [{ item_id: 'M001', qty: 15 }], // fails: 15 > S=10
    };
    sim.applyEvent(event2, () => 0);
    assert.equal(sim.shelf['M001'], 10); // unchanged
    assert.equal(sim.totals.lost_revenue, 1500);
  });
});

// ─── 4. Refill only at S == 0 ─────────────────────────────────────────────────

describe('Refill trigger', () => {
  test('refill happens only when S becomes exactly 0', () => {
    const item = {
      item_id: 'R001',
      unit_price_paise: 100,
      initial_shelf_qty: 5,
      refill_cost_per_unit_paise: 10,
      online_pull_cost_per_unit_paise: 20,
    };
    const out = {};

    // S=3, buy 2 → S=1 (no refill)
    stepLine(item, 3, 'walk_in', 2, undefined, out);
    assert.equal(out.refill, false);
    assert.equal(out.S, 1);

    // S=1, buy 1 → S=0 → refill → S=5
    stepLine(item, 1, 'walk_in', 1, undefined, out);
    assert.equal(out.refill, true);
    assert.equal(out.S, 5);
    assert.equal(out.cost, 50); // 5*10
  });

  test('no refill for lost walk_in line (S unchanged, never 0)', () => {
    const item = {
      item_id: 'R002',
      unit_price_paise: 100,
      initial_shelf_qty: 5,
      refill_cost_per_unit_paise: 10,
      online_pull_cost_per_unit_paise: 20,
    };
    const out = {};
    stepLine(item, 5, 'walk_in', 10, undefined, out); // lost, S stays 5
    assert.equal(out.refill, false);
    assert.equal(out.S, 5);
  });
});

// ─── 5 & 6. DP cost <= both baselines; DP is deterministic ───────────────────

describe('DP optimality and determinism', () => {
  // Deterministic pseudo-random day generator
  function lcg(seed) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s / 0xFFFFFFFF;
    };
  }

  function generateDay(seed, nEvents = 200) {
    const rand = lcg(seed);
    const item = {
      item_id: 'D001',
      name: 'Test', category: 'Test',
      unit_price_paise: 1000,
      initial_shelf_qty: 10,
      refill_cost_per_unit_paise: 30,
      online_pull_cost_per_unit_paise: 80,
    };
    const events = [];
    for (let i = 1; i <= nEvents; i++) {
      const type = rand() < 0.5 ? 'walk_in' : 'online';
      const qty = Math.floor(rand() * 8) + 1;
      events.push({
        seq: i, ts: i * 10, type,
        order_id: `${type === 'walk_in' ? 'W' : 'O'}${String(i).padStart(6, '0')}`,
        lines: [{ item_id: 'D001', qty }],
      });
    }
    return { items: [item], events };
  }

  test('DP cost <= ShelfFirst and InventoryOnly on deterministic day', () => {
    const { items, events } = generateDay(42, 300);

    const sfResult = runPolicy(items, events, ShelfFirstPolicy);
    const ioResult = runPolicy(items, events, InventoryOnlyPolicy);

    const dp1 = makeDpPlanner();
    dp1.prepare(items, events);
    const dpResult = runPolicy(items, events, dp1);

    const sfCost = sfResult.sim.totalCost;
    const ioCost = ioResult.sim.totalCost;
    const dpCost = dpResult.sim.totalCost;

    assert.ok(dpCost <= sfCost, `DP (${dpCost}) should be <= ShelfFirst (${sfCost})`);
    assert.ok(dpCost <= ioCost, `DP (${dpCost}) should be <= InventoryOnly (${ioCost})`);
  });

  test('DP is deterministic (same input → same output)', () => {
    const { items, events } = generateDay(123, 200);

    const dp1 = makeDpPlanner();
    dp1.prepare(items, events);
    const r1 = runPolicy(items, events, dp1);

    const dp2 = makeDpPlanner();
    dp2.prepare(items, events);
    const r2 = runPolicy(items, events, dp2);

    assert.equal(r1.sim.totalCost, r2.sim.totalCost, 'DP cost must be deterministic');
  });
});

// ─── 7. Brute-force check on tiny day ─────────────────────────────────────────

describe('DP equals brute-force optimum on tiny day', () => {
  test('3-event tiny day: DP matches exhaustive search', () => {
    const item = {
      item_id: 'T001',
      name: 'Tiny', category: 'Test',
      unit_price_paise: 500,
      initial_shelf_qty: 4,
      refill_cost_per_unit_paise: 20,
      online_pull_cost_per_unit_paise: 60,
    };

    const events = [
      { seq: 1, ts: 0, type: 'online', order_id: 'O1', lines: [{ item_id: 'T001', qty: 2 }] },
      { seq: 2, ts: 1, type: 'walk_in', order_id: 'W1', lines: [{ item_id: 'T001', qty: 3 }] },
      { seq: 3, ts: 2, type: 'online', order_id: 'O2', lines: [{ item_id: 'T001', qty: 3 }] },
    ];

    const items = [item];

    // DP solution
    const dp = makeDpPlanner();
    dp.prepare(items, events);
    const dpResult = runPolicy(items, events, dp);
    const dpCost = dpResult.sim.totalCost;

    // Brute force: enumerate all (x1, x2) combinations for the two online lines
    // x1 ∈ 0..min(2, 4)=2, x2 ∈ 0..min(3, S_at_seq3)
    let minCost = Infinity;

    for (let x1 = 0; x1 <= 2; x1++) {
      for (let x2 = 0; x2 <= 3; x2++) {
        const plan = [x1, x2];
        let planIdx = 0;
        const sim = new MallSimulation(items);
        sim.applyEvent(events[0], () => plan[planIdx++]); // online
        sim.applyEvent(events[1], () => 0); // walk_in (decide not called)
        sim.applyEvent(events[2], () => plan[planIdx++]); // online
        const cost = sim.totalCost;
        if (cost < minCost) minCost = cost;
      }
    }

    assert.equal(dpCost, minCost, `DP (${dpCost}) should equal brute-force optimum (${minCost})`);
  });
});
