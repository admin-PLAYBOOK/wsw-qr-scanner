// server.js
// Minimal backend for the WSW check-in scanner.
// Keeps the Checkout Page API key on the server. The browser never sees it.

require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.CHECKOUT_PAGE_API_KEY;
const API_BASE = 'https://api.checkoutpage.com/v1';

if (!API_KEY) {
  console.error('Missing CHECKOUT_PAGE_API_KEY. Copy .env.example to .env and add your key.');
  process.exit(1);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// A tiny in-memory list of who checked in this session, for the dashboard log.
// Fine for a single check-in desk; see README if you need it shared across multiple devices.
const recentCheckIns = [];

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
      // Checkout Page returned an error (not found, already checked in, bad key, etc.)
      return res.status(response.status).json({
        ok: false,
        status: response.status,
        message: body?.message || 'Ticket could not be validated.',
      });
    }

    const ticket = body?.data?.ticket;
    const wasAlreadyCheckedIn =
      ticket?.checkIns && ticket.checkIns.length > 1
        ? true
        : ticket?.checkInStatus === 'CHECKEDIN' && ticket?.checkIns?.length > 1;

    const result = {
      ok: true,
      success: body?.data?.success,
      message: body?.data?.message,
      ticket: {
        id: ticket?.id,
        attendeeName: ticket?.attendeeName || ticket?.customerName,
        attendeeEmail: ticket?.attendeeEmail || ticket?.customerEmail,
        ticketTypeId: ticket?.ticketTypeId,
        checkInStatus: ticket?.checkInStatus,
        latestCheckIn: ticket?.latestCheckIn,
        checkInCount: ticket?.checkIns?.length || 0,
      },
    };

    recentCheckIns.unshift({ ...result.ticket, scannedAt: new Date().toISOString() });
    if (recentCheckIns.length > 50) recentCheckIns.pop();

    res.json(result);
  } catch (err) {
    console.error('Error calling Checkout Page API:', err);
    res.status(502).json({ ok: false, message: 'Could not reach Checkout Page. Try again.' });
  }
});

app.get('/api/recent', (req, res) => {
  res.json({ ok: true, recent: recentCheckIns });
});

app.listen(PORT, () => {
  console.log(`WSW scanner running at http://localhost:${PORT}`);
});
