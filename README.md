# WSW Check-in Scanner

A phone-friendly page that scans a ticket's QR code and checks it in via the
Checkout Page API — across **all events**, since `checkInCode` is validated
directly with no event ID needed.

## How it works

```
Phone camera → scans QR → sends checkInCode to your server
                                   │
                                   ▼
                    your server calls Checkout Page API
                          (API key lives here only)
                                   │
                                   ▼
                    result shown on the phone screen
```

The API key never touches the browser. The phone only ever talks to your
own server; your server is the only thing that holds the key and talks to
`api.checkoutpage.com`.

## 1. Install

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
cd wsw-scanner
npm install
```

## 2. Add your API key

```bash
cp .env.example .env
```

Open `.env` and paste in the key you generated at
Settings → API Keys → Generate API key:

```
CHECKOUT_PAGE_API_KEY=cp_live_xxxxxxxxxxxxxxxx
```

Never commit `.env` or paste the key into the frontend code — `.gitignore`
already excludes it.

## 3. Run it

```bash
npm start
```

Visit `http://localhost:3000` on your computer to test the camera works.

## 4. Use it at the door on a phone

For a phone's camera to work, the page generally needs to be served over
**HTTPS** (or accessed as `localhost`, which browsers exempt). Easiest
options:

- **Deploy it** to a free host like [Render](https://render.com),
  [Railway](https://railway.app), or [Fly.io](https://fly.io) — each gives
  you HTTPS automatically. Set `CHECKOUT_PAGE_API_KEY` as an environment
  variable in their dashboard (not in a file you upload).
- **Or tunnel it** temporarily for a single event with
  [ngrok](https://ngrok.com): run `npm start`, then `ngrok http 3000`, and
  open the `https://...ngrok...` link it gives you on the phone.

Once it's loaded, open it in the phone's browser, tap "Allow" for camera
access, and start scanning. Each scan shows:

- **Green — Welcome, [name]** → valid, first check-in
- **Amber — Already checked in** → valid ticket, but scanned before
- **Red — Not valid** → wrong/fake code, or an error reaching the API

The camera pauses briefly after each scan (or tap the screen) before it's
ready for the next person, and a running "Recent scans" log is available
below the result.

## Running multiple scanner phones at once

Right now the "recent scans" list lives in the server's memory, so it's
shared across every phone hitting the same server — that part already
works for multiple doors. If you want to scale beyond a single small
server (e.g., a persistent log after restarts, or dashboards elsewhere),
say the word and I can wire that up too.

## Files

- `server.js` — Express backend; the only thing that holds your API key
- `public/index.html` — the scanner page staff open on their phones
- `.env.example` — template for your local `.env` (never committed)
