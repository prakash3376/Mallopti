'use strict';
/**
 * server.js — Boot only. Sets up Express, CORS, middleware, and starts listening.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const routes = require('./api/routes');

// Ensure data directory exists for SQLite
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const app = express();

// CORS
app.use(cors());

// JSON body parser — 30 MB limit
app.use(express.json({ limit: '30mb' }));

// Handle malformed JSON
app.use((err, _req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'bad_request', message: 'Malformed JSON: ' + err.message });
  }
  next(err);
});

// API routes
app.use('/api/v1', routes);

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`[server] Mall Operations Optimiser backend listening on port ${PORT}`);
});

module.exports = app;
