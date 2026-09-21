// server.js
// Backend for the WSW check-in scanner.
// Keeps the Checkout Page API key on the server. The browser never sees it.

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.CHECKOUT_PAGE_API_KEY;
const API_BASE = 'https://api.checkoutpage.com/v1';
const ADMIN_KEY = process.env.ADMIN_KEY || 'wsw-admin';

if (!API_KEY) {
  console.error('Missing CHECKOUT_PAGE_API_KEY. Copy .env.example to .env and add your key.');
  process.exit(1);
}

app.use(express.json({ limit: '5mb' })); // CSV pastes can be sizable
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Storage: Postgres if DATABASE_URL is set (e.g. Railway's Postgres add-on),
// otherwise flat JSON files on disk — so local dev works with zero setup,
// and the event itself can run on a real database with no code changes,
// just by attaching Postgres in Railway.
//
// Either way, checkedIn and roster are also kept in memory and used for all
// reads/lookups (so scanning stays instant regardless of storage backend);
// writes go to memory AND to storage together ("write-through").
// ---------------------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL;
const useDb = Boolean(DATABASE_URL);

let pool = null;
if (useDb) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

const CHECKINS_PATH = path.join(__dirname, 'checkins.json');
const ROSTER_PATH = path.join(__dirname, 'roster.json');

function loadJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

let checkedIn = {}; // { [ticketId]: { name, email, category, checkedInAt } }
let roster = { entries: [], byCode: {}, byOrderId: {}, byEmail: {}, byName: {} };
const recentCheckIns = [];

function normalize(value) {
  return (value || '').toString().trim().toLowerCase();
}

function rebuildRosterIndexes() {
  roster.byCode = {};
  roster.byOrderId = {};
  roster.byEmail = {};
  roster.byName = {};
  for (const entry of roster.entries) {
    if (entry.code) roster.byCode[normalize(entry.code)] = entry;
    if (entry.orderId) roster.byOrderId[normalize(entry.orderId)] = entry;
    if (entry.email) roster.byEmail[normalize(entry.email)] = entry;
    if (entry.name) roster.byName[normalize(entry.name)] = entry;
  }
}

async function initStorage() {
  if (useDb) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS checkins (
        ticket_id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT,
        category TEXT,
        checked_in_at TIMESTAMPTZ,
        roster_entry_id TEXT
      )
    `);
    await pool.query(`ALTER TABLE checkins ADD COLUMN IF NOT EXISTS roster_entry_id TEXT`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS roster (
        id SERIAL PRIMARY KEY,
        entry_id TEXT UNIQUE,
        category TEXT NOT NULL,
        name TEXT,
        email TEXT,
        code TEXT,
        order_id TEXT
      )
    `);
    await pool.query(`ALTER TABLE roster ADD COLUMN IF NOT EXISTS entry_id TEXT`);

    const checkinsRes = await pool.query('SELECT ticket_id, name, email, category, checked_in_at, roster_entry_id FROM checkins');
    checkedIn = {};
    for (const row of checkinsRes.rows) {
      checkedIn[row.ticket_id] = {
        name: row.name,
        email: row.email,
        category: row.category,
        checkedInAt: row.checked_in_at ? new Date(row.checked_in_at).toISOString() : new Date().toISOString(),
        rosterEntryId: row.roster_entry_id || null,
      };
    }

    const rosterRes = await pool.query('SELECT entry_id, category, name, email, code, order_id FROM roster');
    roster.entries = rosterRes.rows.map((r) => ({
      entryId: r.entry_id, category: r.category, name: r.name, email: r.email, code: r.code, orderId: r.order_id,
    }));

    console.log(`Storage: Postgres. Loaded ${Object.keys(checkedIn).length} check-ins, ${roster.entries.length} roster entries.`);
  } else {
    checkedIn = loadJSON(CHECKINS_PATH, {});
    roster = loadJSON(ROSTER_PATH, { entries: [], byCode: {}, byOrderId: {}, byEmail: {}, byName: {} });
    console.log('Storage: local JSON files (no DATABASE_URL set). Attach Postgres in Railway for durable storage.');
  }
  rebuildRosterIndexes();
}

async function persistCheckIn(ticketId, record) {
  checkedIn[ticketId] = record; // memory updates instantly regardless of backend
  if (useDb) {
    await pool.query(
      `INSERT INTO checkins (ticket_id, name, email, category, checked_in_at, roster_entry_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (ticket_id) DO NOTHING`,
      [ticketId, record.name, record.email, record.category, record.checkedInAt, record.rosterEntryId || null]
    );
  } else {
    saveJSON(CHECKINS_PATH, checkedIn);
  }
}

async function persistRosterCategory(category, entries) {
  roster.entries = roster.entries.filter((e) => e.category !== category).concat(entries);
  rebuildRosterIndexes();

  if (useDb) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM roster WHERE category = $1', [category]);
      for (const e of entries) {
        await client.query(
          'INSERT INTO roster (entry_id, category, name, email, code, order_id) VALUES ($1, $2, $3, $4, $5, $6)',
          [e.entryId, category, e.name, e.email, e.code, e.orderId]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else {
    saveJSON(ROSTER_PATH, roster);
  }
}

// ---------------------------------------------------------------------------
// CSV parsing + roster matching
// ---------------------------------------------------------------------------

// Tiny CSV parser: handles quoted fields with commas/quotes inside them.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function findColumn(headers, candidates) {
  const lower = headers.map((h) => normalize(h));
  for (const candidate of candidates) {
    const idx = lower.findIndex((h) => h === candidate);
    if (idx !== -1) return idx;
  }
  for (const candidate of candidates) {
    const idx = lower.findIndex((h) => h.includes(candidate));
    if (idx !== -1) return idx;
  }
  return -1;
}

function findCollisions(newEntries, category) {
  const others = roster.entries.filter((e) => e.category !== category);
  const collisions = [];
  for (const e of newEntries) {
    const match = others.find((o) =>
      (e.orderId && normalize(o.orderId) === normalize(e.orderId)) ||
      (e.code && normalize(o.code) === normalize(e.code)) ||
      (e.email && normalize(o.email) === normalize(e.email))
    );
    if (match) {
      collisions.push(`${e.name || e.email || e.orderId} is already listed under "${match.category}" — this upload moves them to "${category}".`);
    }
  }
  return collisions;
}

async function addCategoryFromCSV(category, csvText) {
  const rows = parseCSV(csvText);
  if (!rows.length) return { added: 0, error: 'No rows found in CSV.' };

  const headers = rows[0];
  const orderIdCol = findColumn(headers, ['order id', 'orderid', 'order']);
  const codeCol = findColumn(headers, ['ticket code', 'ticketcode', 'ticket id', 'code']);
  const emailCol = findColumn(headers, ['email']);
  const nameCol = findColumn(headers, ['name', 'full name', 'attendee']);

  if (orderIdCol === -1 && codeCol === -1 && emailCol === -1 && nameCol === -1) {
    return { added: 0, error: 'Could not find an order ID, name, email, or ticket code column in the CSV header row.' };
  }

  // Re-uploading a category (e.g. to fix a typo or add late guests) replaces
  // its rows — but anyone already checked in from the OLD version is linked
  // by entryId, so we carry that id forward for any row that still matches
  // (by order id/code/email/name) rather than minting a fresh id for
  // everyone, which would silently orphan already-checked-in guests.
  const previousEntries = roster.entries.filter((e) => e.category === category);
  function findPreviousEntryId(row) {
    const match = previousEntries.find((p) =>
      (row.orderId && normalize(p.orderId) === normalize(row.orderId)) ||
      (row.code && normalize(p.code) === normalize(row.code)) ||
      (row.email && normalize(p.email) === normalize(row.email))
    );
    return match ? match.entryId : crypto.randomUUID();
  }

  const entries = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = nameCol !== -1 ? (r[nameCol] || '').trim() : '';
    const email = emailCol !== -1 ? (r[emailCol] || '').trim() : '';
    const code = codeCol !== -1 ? (r[codeCol] || '').trim() : '';
    const orderId = orderIdCol !== -1 ? (r[orderIdCol] || '').trim() : '';
    if (!name && !email && !code && !orderId) continue;
    const row = { category, name, email, code, orderId };
    entries.push({ ...row, entryId: findPreviousEntryId(row) });
  }

  const warnings = findCollisions(entries, category);
  await persistRosterCategory(category, entries);
  return { added: entries.length, warnings };
}

const DEFAULT_CATEGORY = 'Delegate';

function findRosterMatch(ticket) {
  return (
    (ticket.orderId && roster.byOrderId[normalize(ticket.orderId)]) ||
    (ticket.ticketShortId && roster.byCode[normalize(ticket.ticketShortId)]) ||
    (ticket.attendeeEmail && roster.byEmail[normalize(ticket.attendeeEmail)]) ||
    null
  );
}

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ ok: false, message: 'Bad admin key.' });
  next();
}

// Combines the uploaded roster (who's expected) with checkedIn (who's actually
// scanned) into one list: every roster guest, plus anyone who got scanned but
// wasn't found on any uploaded sheet (i.e. real Delegates, category defaulted
// at scan time). Used by both the live /status page and the CSV export.
//
// Matching is by the exact roster entryId captured at scan time (not a fresh
// name/email re-comparison), so a guest whose sheet name/email differs
// slightly from their actual ticket still shows correctly as checked in.
function getFullReport() {
  const validEntryIds = new Set(roster.entries.map((e) => e.entryId).filter(Boolean));
  const checkedInByEntryId = {};
  for (const c of Object.values(checkedIn)) {
    if (c.rosterEntryId) checkedInByEntryId[c.rosterEntryId] = c;
  }

  const rosterRows = roster.entries.map((entry) => {
    const c = entry.entryId ? checkedInByEntryId[entry.entryId] : null;
    return {
      name: entry.name,
      email: entry.email,
      category: entry.category,
      orderId: entry.orderId || '',
      code: entry.code || '',
      checkedIn: Boolean(c),
      checkedInAt: c ? c.checkedInAt : null,
    };
  });

  // Anyone checked in whose roster link is missing entirely, OR points at an
  // entry that no longer exists (e.g. removed in a later re-upload of that
  // category) — surfaced here instead of silently disappearing from the report.
  const walkInRows = Object.values(checkedIn)
    .filter((c) => !c.rosterEntryId || !validEntryIds.has(c.rosterEntryId))
    .map((c) => ({
      name: c.name,
      email: c.email || '',
      category: c.category || DEFAULT_CATEGORY,
      orderId: '',
      code: '',
      checkedIn: true,
      checkedInAt: c.checkedInAt,
    }));

  return [...rosterRows, ...walkInRows];
}

function csvEscape(value) {
  const s = (value ?? '').toString();
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---------------------------------------------------------------------------
// Check-in endpoint (public — this is what the scanner page calls)
// ---------------------------------------------------------------------------
app.post('/api/checkin', async (req, res) => {
  const { code } = req.body;

  if (!code || typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ ok: false, message: 'No code provided.' });
  }

  const checkInCode = encodeURIComponent(code.trim());

  try {
    const response = await fetch(`${API_BASE}/tickets/validate/${checkInCode}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const body = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        status: response.status,
        message: body?.message || 'Ticket could not be validated.',
      });
    }

    const ticket = body?.data?.ticket;

    if (ticket?.status !== 'PAID') {
      return res.status(422).json({ ok: false, message: `Ticket status is "${ticket?.status}", not valid for entry.` });
    }

    const name = ticket?.attendeeName || ticket?.customerName || 'Ticket holder';
    const email = ticket?.attendeeEmail || ticket?.customerEmail;
    const match = findRosterMatch({
      orderId: ticket?.orderId,
      ticketShortId: ticket?.ticketShortId,
      attendeeEmail: email,
      attendeeName: name,
    });
    const category = match ? match.category : DEFAULT_CATEGORY;
    const existing = checkedIn[ticket.id];

    const result = {
      ok: true,
      alreadyCheckedIn: Boolean(existing),
      ticket: {
        id: ticket.id,
        attendeeName: name,
        attendeeEmail: email,
        ticketShortId: ticket?.ticketShortId,
        ticketTypeId: ticket?.ticketTypeId,
        category,
        checkedInAt: existing ? existing.checkedInAt : new Date().toISOString(),
      },
    };

    if (!existing) {
      await persistCheckIn(ticket.id, {
        name, email, category,
        checkedInAt: result.ticket.checkedInAt,
        rosterEntryId: match ? match.entryId : null,
      });
    }

    recentCheckIns.unshift({ ...result.ticket, alreadyCheckedIn: result.alreadyCheckedIn });
    if (recentCheckIns.length > 50) recentCheckIns.pop();

    res.json(result);
  } catch (err) {
    console.error('Error calling Checkout Page API:', err);
    res.status(502).json({ ok: false, message: 'Could not reach Checkout Page. Try again.' });
  }
});

// Public, PII-free: just a number, so the scanner page can restore its
// "checked in so far" count after a refresh without needing admin access.
app.get('/api/checkin-count', (req, res) => {
  res.json({ ok: true, count: Object.keys(checkedIn).length });
});

// Recent-scans detail includes names/emails, so this needs the admin key
// (previously this was open to anyone with the URL — now locked down).
app.get('/api/recent', requireAdmin, (req, res) => {
  res.json({ ok: true, recent: recentCheckIns });
});

// ---------------------------------------------------------------------------
// Admin: upload a category's CSV, view roster + status
// ---------------------------------------------------------------------------
app.post('/api/admin/roster', requireAdmin, async (req, res) => {
  const { category, csv } = req.body;
  if (!category || !category.trim()) return res.status(400).json({ ok: false, message: 'Category name is required.' });
  if (!csv || !csv.trim()) return res.status(400).json({ ok: false, message: 'CSV text is required.' });

  try {
    const result = await addCategoryFromCSV(category.trim(), csv);
    if (result.error) return res.status(400).json({ ok: false, message: result.error });
    res.json({ ok: true, added: result.added, category: category.trim(), warnings: result.warnings || [] });
  } catch (err) {
    console.error('Error saving roster:', err);
    res.status(500).json({ ok: false, message: 'Could not save roster.' });
  }
});

app.get('/api/admin/roster-summary', requireAdmin, (req, res) => {
  const categories = {};
  for (const entry of roster.entries) {
    categories[entry.category] = (categories[entry.category] || 0) + 1;
  }
  res.json({ ok: true, totalEntries: roster.entries.length, categories });
});

app.get('/api/status', requireAdmin, (req, res) => {
  res.json({ ok: true, rows: getFullReport() });
});

app.get('/api/admin/export', requireAdmin, (req, res) => {
  const rows = getFullReport();
  const header = ['Name', 'Email', 'Category', 'Order ID', 'Ticket Code', 'Checked In', 'Checked In At'];
  const body = rows.map((r) => [
    r.name, r.email, r.category, r.orderId, r.code,
    r.checkedIn ? 'Yes' : 'No',
    r.checkedInAt ? new Date(r.checkedInAt).toLocaleString() : '',
  ]);
  const csv = [header, ...body].map((row) => row.map(csvEscape).join(',')).join('\r\n');
  const filename = `wsw-guestlist-${new Date().toISOString().slice(0, 10)}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

initStorage()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`WSW scanner running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize storage:', err);
    process.exit(1);
  });