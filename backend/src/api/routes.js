'use strict';
/**
 * routes.js — HTTP layer only: validation, error mapping, no business rules.
 * All business logic is in services/dayService.js.
 */

const express = require('express');
const dayService = require('../services/dayService');

const router = express.Router();

// ─── Health ───────────────────────────────────────────────────────────────────

router.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ─── Day load ─────────────────────────────────────────────────────────────────

router.post('/day/load', async (req, res) => {
  try {
    const { day_id, items, events } = req.body || {};

    if (!day_id || typeof day_id !== 'string') {
      return res.status(400).json({ error: 'bad_request', message: 'day_id is required' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'bad_request', message: 'items array is required' });
    }
    if (!Array.isArray(events)) {
      return res.status(400).json({ error: 'bad_request', message: 'events array is required' });
    }

    const result = await dayService.load({ day_id, items, events });
    return res.json(result);
  } catch (err) {
    console.error('[routes] /day/load error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ─── Day events (live simulation) ─────────────────────────────────────────────

router.post('/day/events', (req, res) => {
  try {
    const event = req.body;

    if (!event || typeof event.seq !== 'number') {
      return res.status(400).json({ error: 'bad_request', message: 'seq is required' });
    }

    const result = dayService.processEvent(event);

    if (result && result.error === 'out_of_order') {
      return res.status(409).json(result);
    }

    return res.json(result);
  } catch (err) {
    console.error('[routes] /day/events error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ─── Days history ─────────────────────────────────────────────────────────────

router.get('/days', (_req, res) => {
  try {
    const history = dayService.getHistory();
    return res.json(history);
  } catch (err) {
    console.error('[routes] /days error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ─── Current day ──────────────────────────────────────────────────────────────

router.get('/day/current', (_req, res) => {
  try {
    return res.json(dayService.getCurrent());
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ─── Day summary ──────────────────────────────────────────────────────────────

router.get('/day/:id/summary', (req, res) => {
  try {
    const summary = dayService.getSummary(req.params.id);
    if (!summary) {
      return res.status(404).json({ error: 'not_found', message: 'Day not found' });
    }
    return res.json(summary);
  } catch (err) {
    console.error('[routes] /day/:id/summary error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ─── Day series ───────────────────────────────────────────────────────────────

router.get('/day/:id/series', (req, res) => {
  try {
    const series = dayService.getSeries(req.params.id);
    if (!series) {
      return res.status(404).json({ error: 'not_found', message: 'Day not found' });
    }
    return res.json(series);
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ─── Day events ledger ────────────────────────────────────────────────────────

router.get('/day/:id/events', (req, res) => {
  try {
    const { limit = '50', offset = '0', order = 'asc' } = req.query;
    const result = dayService.getEvents(req.params.id, limit, offset, order);
    return res.json(result);
  } catch (err) {
    console.error('[routes] /day/:id/events error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

module.exports = router;
