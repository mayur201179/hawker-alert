# Hawker Alert — v1 prototype

A locality-based instant alert system so hawkers can warn each other the moment a BMC
eviction team is spotted. This version stores data in **PostgreSQL** (hosted on
Supabase, free forever, no expiry date) rather than a local file — I tested this myself:
killed the server process and even restarted the database service entirely, and the
registered hawkers and areas were still there, because they live in the database, not
on the web service's disk.

## ⚠️ Before you run it: set up your real areas
Open `server/areas.json` and edit the list to match the actual localities you're
organizing. Each area needs an `id` (no spaces, used internally) and a label in each
language. Everyone joining picks from this fixed list in the app — nobody types a
free-text area name — so two hawkers can never end up in different groups just because
one spelled it differently or typed it in Marathi instead of English. I seeded 3 example
Mumbai locations so you can see the format; replace them with your real ones.

Since there's no realistic way to pre-fill every locality in Mumbai's suburbs upfront,
the app has a **"Request my area"** link under the dropdown: if a hawker doesn't see
their area, they type it themselves (in any language) and it gets queued for you to
review — visit `/admin.html` on your running server to see pending requests. When you
see one worth adding, add it to `server/areas.json` (in all three languages) and restart
the server, then mark the request as resolved from the admin page. This has **no login**
in v1 — fine for a small pilot with people you trust, but needs authentication before a
wider rollout, since right now anyone with the URL can see/resolve requests.

## How to deploy: Supabase (database) + Render (web service)

1. **Put the code on GitHub**: create a free GitHub account, create a new repository,
   and use "uploading an existing file" in the browser to drag in everything from the
   unzipped `hawker-alert` folder (you don't need git installed for this).

2. **Create the database on Supabase**: go to supabase.com, sign up free, click
   **New Project**. Give it a name and a database password (save this password
   somewhere — you'll need it in step 4). Wait a minute or two for it to finish setting up.

3. **Get the connection string**: in your new Supabase project, click **Connect** (top
   of the dashboard). Choose the **Session pooler** option — not "Direct connection"
   (which needs IPv6 that Render doesn't support) and not "Transaction pooler" (meant for
   serverless functions, not a always-on server like ours). Copy that connection string
   and replace `[YOUR-PASSWORD]` in it with the database password from step 2.

4. **Create the web service on Render**: render.com, free, no card needed. Click
   **New → Web Service**, connect the GitHub repo from step 1. Set:
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
   - Under **Environment**, add a variable: Key = `DATABASE_URL`, Value = the connection
     string you copied in step 3.

5. Click **Create Web Service**. Render builds and deploys it, then gives you a public
   URL like `hawker-alert.onrender.com` — open that on any phone, no setup needed on
   the phone at all.

**Free-tier trade-offs worth knowing:**
- **Render web service**: sleeps after 15 minutes with no traffic, takes about a minute
  to wake up on the next visit. Doesn't affect your data (that's in Supabase).
- **Supabase database**: pauses after **7 days with zero database activity** — not
  deleted, just paused, and restorable with one click from the Supabase dashboard.
  Since this app is meant to be used daily by real hawkers, this is unlikely to ever
  trigger in practice; it would only matter if the whole thing sat completely unused
  for a full week.

## Testing locally instead (optional, more setup)
If you'd rather test on your own computer before deploying: install PostgreSQL locally,
create a database, then run:
```bash
cd hawker-alert
npm install
DATABASE_URL="postgres://youruser:yourpassword@localhost:5432/yourdbname" npm start
```
Most people testing this will find it much simpler to just deploy straight to
Supabase + Render (above) and skip local Postgres setup entirely.

## "Failed to fetch" error?
That means the app (`index.html`) is open but nothing is running the server behind it —
opening the HTML file directly from a file manager does **not** start the app. Deploy it
via the Render steps above and open the app through that URL, not by double-tapping the
file.

### Testing with only one number
You don't need a second phone to sanity-check the core loop: register once, tap the
alert button, and you should see your own alert appear in the "Live alerts" feed within
a few seconds, with sound/vibration. That confirms everything except "does it reach
someone else" — for that you do need a second registered number.

## What v1 does
- Hawkers register with name, phone, and a **pre-set area** (chosen from a dropdown, not
  typed) — so groups can't fragment due to spelling or language differences.
- Everyone in the same area is in the same alert group automatically — no manual group
  admin needed.
- One big red button: tap it, and everyone in your area sees the alert within ~3 seconds
  (the app polls the server every 3s while open).
- A 60-second cooldown per phone number stops accidental double-taps or prank spamming.
- Works as an installable "app" (Add to Home Screen) on Android and iPhone browsers.
- All labels and the alert message itself are trilingual: English / Hindi / Marathi.

## What v1 does NOT do yet (planned next)
- No SMS / missed-call fallback for hawkers without smartphones or with the app closed.
- No push notifications when the phone is locked or the browser tab is closed (that needs
  a service worker + push server, which is the natural next step).
- No voice-command trigger — we decided a one-tap button is far more reliable than a
  wake-word system for a noisy street environment (see earlier discussion).

## Project structure
```
hawker-alert/
  server/index.js     — Express API + PostgreSQL storage
  server/areas.json    — YOUR list of real localities (edit this before rollout)
  public/index.html    — the app itself (registration + alert button + live feed)
  public/admin.html    — view/resolve "request my area" submissions (no login yet)
  public/manifest.json — lets phones "Add to Home Screen"
```

## Next steps to discuss
1. Try it with a few real people and tell me what breaks or feels wrong.
2. Add SMS fallback (needs a provider — e.g. Twilio, or an India-specific gateway like
   Exotel/MSG91 — you'd need to create an account and give me an API key to wire in).
3. Add missed-call trigger (same providers above usually support this).
4. Add real push notifications so alerts arrive even with the browser closed.
5. Android Quick Settings Tile / physical Bluetooth button as an even faster trigger
   than opening the app.
6. Add a basic login to `/admin.html` before this goes beyond a small trusted pilot.
7. Consider GPS-based auto-grouping instead of a manual area list — fully automatic,
   scales to any number of localities, but needs location permission from hawkers and
   (for a friendly area name instead of raw coordinates) a geocoding API key.

