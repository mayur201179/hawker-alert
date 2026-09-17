const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;
const AREAS_PATH = path.join(__dirname, 'areas.json');

// ---------- Push notifications (so alerts reach a phone even with the app closed) ----------
// Requires VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY environment variables. If they're
// not set, push notifications are simply skipped — polling (while the app is open)
// still works fine either way.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const pushConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushConfigured) {
  webpush.setVapidDetails('mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push notifications disabled, polling still works.');
}

// ---------- Postgres connection ----------
// DATABASE_URL should be set to your Supabase "Session pooler" connection string
// (Project → Connect → Session pooler), with [YOUR-PASSWORD] replaced with your
// actual database password. For local testing, set it yourself, e.g.:
//   DATABASE_URL=postgres://postgres:yourpassword@localhost:5432/hawkeralert
if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL environment variable — set it to your Postgres connection string.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Any hosted Postgres provider (Supabase, Render, etc.) requires SSL; only a
  // local database on your own machine doesn't. Detecting by "is it localhost"
  // is more robust than matching specific provider hostnames.
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')
    ? false
    : { rejectUnauthorized: false }
});

// ---------- Canonical area list ----------
// Edit server/areas.json to add/remove real localities. Using a fixed list (instead
// of free-text entry) means two hawkers can never end up in different groups just
// because they spelled the area differently or typed it in a different language.
// AREAS is an in-memory cache, refreshed from the database (see loadAreasFromDb
// below). areas.json is only used to SEED the database the very first time this
// app runs against a brand-new empty database — after that, areas.json is not
// read again. Areas are added going forward via the admin page, which writes to
// the database directly and updates this cache immediately, so a newly approved
// area appears in the dropdown right away with no GitHub edit or redeploy needed.
let AREAS = [];

function loadAreasFromJsonFile() {
  try {
    return JSON.parse(fs.readFileSync(AREAS_PATH, 'utf8'));
  } catch (e) {
    console.error('Could not load areas.json:', e.message);
    return [];
  }
}

async function loadAreasFromDb() {
  const result = await pool.query('SELECT id, en, hi, mr FROM areas ORDER BY en');
  AREAS = result.rows;
}

function findArea(id) {
  return AREAS.find(a => a.id === id);
}

function slugifyAreaName(name) {
  const base = String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let candidate = base || 'area';
  let n = 2;
  while (findArea(candidate)) {
    candidate = `${base}-${n}`;
    n++;
  }
  return candidate;
}

// ---------- Schema ----------
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hawkers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      area TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alerts (
      id SERIAL PRIMARY KEY,
      area TEXT NOT NULL,
      message TEXT NOT NULL,
      triggered_by_phone TEXT,
      triggered_by_name TEXT,
      created_at BIGINT NOT NULL
    );
  `);
  // Migration for databases created before triggered_by_name existed (e.g. your
  // already-deployed Supabase database) — safe to run every startup, it's a no-op
  // once the column exists.
  await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS triggered_by_name TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS area_requests (
      id SERIAL PRIMARY KEY,
      requested_name TEXT NOT NULL,
      phone TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      phone TEXT PRIMARY KEY,
      area TEXT NOT NULL,
      subscription TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS areas (
      id TEXT PRIMARY KEY,
      en TEXT NOT NULL,
      hi TEXT NOT NULL,
      mr TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_hawkers_area ON hawkers(area);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_alerts_area_time ON alerts(area, created_at);`);

  // One-time seed: if the areas table is empty (brand-new database), populate it
  // from areas.json so existing deployments (and their already-registered hawkers,
  // whose "area" column references these same ids) keep working unchanged.
  const countRes = await pool.query('SELECT COUNT(*) as c FROM areas');
  if (Number(countRes.rows[0].c) === 0) {
    const seed = loadAreasFromJsonFile();
    for (const a of seed) {
      await pool.query(
        'INSERT INTO areas (id, en, hi, mr, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
        [a.id, a.en, a.hi, a.mr, Date.now()]
      );
    }
  }

  await loadAreasFromDb();
}

// ---------- Simple in-memory rate limit (per phone) ----------
// Prevents accidental spam / prank-mashing of the alert button.
// (This resets on restart, which is fine — it's just a soft anti-spam guard,
// not something that needs to survive across deploys.)
const lastAlertByPhone = new Map(); // phone -> timestamp
const ALERT_COOLDOWN_MS = 60 * 1000; // 1 alert per phone per 60s

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Helpers ----------
function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d+]/g, '');
}

// ---------- Routes ----------

// Register (or update) a hawker
app.post('/api/register', async (req, res) => {
  try {
    const { name, phone, area } = req.body;
    if (!name || !phone || !area) {
      return res.status(400).json({ error: 'name, phone, and area are required' });
    }
    const cleanPhone = normalizePhone(phone);
    if (cleanPhone.length < 6) {
      return res.status(400).json({ error: 'invalid phone number' });
    }
    const areaEntry = findArea(area);
    if (!areaEntry) {
      return res.status(400).json({ error: 'Please pick an area from the list' });
    }
    const cleanArea = areaEntry.id;

    const existing = await pool.query('SELECT * FROM hawkers WHERE phone = $1', [cleanPhone]);
    if (existing.rows.length) {
      await pool.query('UPDATE hawkers SET name = $1, area = $2 WHERE phone = $3',
        [name.trim(), cleanArea, cleanPhone]);
    } else {
      await pool.query(
        'INSERT INTO hawkers (name, phone, area, created_at) VALUES ($1, $2, $3, $4)',
        [name.trim(), cleanPhone, cleanArea, Date.now()]
      );
    }
    const row = await pool.query('SELECT * FROM hawkers WHERE phone = $1', [cleanPhone]);
    const hawker = { ...row.rows[0], created_at: Number(row.rows[0].created_at) };
    res.json({ ok: true, hawker, areaLabel: areaEntry });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});

// Check whether a phone number is still a registered hawker. The app calls this
// on load to catch the case where the phone remembers "you're logged in" locally,
// but an admin reset (or manual deletion) has since wiped that record server-side.
app.get('/api/hawkers/:phone', async (req, res) => {
  try {
    const cleanPhone = normalizePhone(req.params.phone);
    const row = await pool.query('SELECT phone FROM hawkers WHERE phone = $1', [cleanPhone]);
    res.json({ exists: row.rows.length > 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});

// List all canonical areas, with live member counts merged in
app.get('/api/areas', async (req, res) => {
  try {
    const counts = await pool.query('SELECT area, COUNT(*) as members FROM hawkers GROUP BY area');
    const countMap = Object.fromEntries(counts.rows.map(c => [c.area, Number(c.members)]));
    const areas = AREAS.map(a => ({ ...a, members: countMap[a.id] || 0 }));
    res.json({ areas });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});

// Frontend fetches this to know the public key to subscribe with. Returns null
// if push isn't configured on this server (frontend just skips push then).
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: pushConfigured ? VAPID_PUBLIC_KEY : null });
});

// Save (or update) a hawker's push subscription for their area.
app.post('/api/push-subscribe', async (req, res) => {
  try {
    const { phone, area, subscription } = req.body;
    if (!phone || !area || !subscription) {
      return res.status(400).json({ error: 'phone, area, and subscription are required' });
    }
    const areaEntry = findArea(area);
    if (!areaEntry) return res.status(400).json({ error: 'unknown area' });
    const cleanPhone = normalizePhone(phone);

    await pool.query(
      `INSERT INTO push_subscriptions (phone, area, subscription, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (phone) DO UPDATE SET area = $2, subscription = $3, created_at = $4`,
      [cleanPhone, areaEntry.id, JSON.stringify(subscription), Date.now()]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});

// Trigger an alert for an area
app.post('/api/alert', async (req, res) => {
  try {
    const { area, phone, name, message } = req.body;
    if (!area || !phone) {
      return res.status(400).json({ error: 'area and phone are required' });
    }
    const cleanPhone = normalizePhone(phone);
    const areaEntry = findArea(area);
    if (!areaEntry) {
      return res.status(400).json({ error: 'unknown area' });
    }
    const cleanArea = areaEntry.id;

    const now = Date.now();
    const last = lastAlertByPhone.get(cleanPhone);
    if (last && now - last < ALERT_COOLDOWN_MS) {
      const waitSec = Math.ceil((ALERT_COOLDOWN_MS - (now - last)) / 1000);
      return res.status(429).json({ error: `Please wait ${waitSec}s before sending another alert` });
    }

    const finalMessage = (message && message.trim()) ||
      'BMC team spotted nearby — cover your goods! / BMC टीम पास में है — अपना सामान ढकें! / बीएमसी टीम जवळ आहे — तुमचा माल झाकून घ्या!';

    await pool.query(
      'INSERT INTO alerts (area, message, triggered_by_phone, triggered_by_name, created_at) VALUES ($1, $2, $3, $4, $5)',
      [cleanArea, finalMessage, cleanPhone, (name || '').trim() || null, now]
    );

    lastAlertByPhone.set(cleanPhone, now);

    const memberCountRes = await pool.query('SELECT COUNT(*) as c FROM hawkers WHERE area = $1', [cleanArea]);

    let pushSent = 0;
    if (pushConfigured) {
      const subs = await pool.query('SELECT phone, subscription FROM push_subscriptions WHERE area = $1', [cleanArea]);
      const payload = JSON.stringify({ title: '🚨 Hawker Alert', body: finalMessage });
      const staleToPrune = [];

      await Promise.all(subs.rows.map(async (row) => {
        try {
          await webpush.sendNotification(JSON.parse(row.subscription), payload);
          pushSent++;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            staleToPrune.push(row.phone); // subscription dead — browser data cleared, etc.
          } else {
            console.warn('Push send failed for', row.phone, ':', err.message);
          }
        }
      }));

      if (staleToPrune.length) {
        await pool.query('DELETE FROM push_subscriptions WHERE phone = ANY($1)', [staleToPrune]);
      }
    }

    res.json({ ok: true, notified: Number(memberCountRes.rows[0].c), pushSent });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});

// Poll for alerts in an area since a given timestamp
app.get('/api/alerts', async (req, res) => {
  try {
    const areaEntry = findArea(req.query.area);
    if (!areaEntry) return res.status(400).json({ error: 'unknown area' });
    const area = areaEntry.id;
    const since = Number(req.query.since || 0);

    const result = await pool.query(
      `SELECT id, area, message, triggered_by_phone, triggered_by_name, created_at
       FROM alerts
       WHERE area = $1 AND created_at > $2
       ORDER BY created_at ASC
       LIMIT 50`,
      [area, since]
    );

    // node-postgres returns BIGINT columns as strings (to avoid silent precision
    // loss on huge numbers), but that breaks `new Date(...)` on the frontend, which
    // needs a real number. Converting here means every consumer of this API gets a
    // correct numeric timestamp without having to remember to convert it themselves.
    const alerts = result.rows.map(r => ({ ...r, created_at: Number(r.created_at) }));

    res.json({ alerts, serverTime: Date.now() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (e) {
    res.status(500).json({ ok: false, db: 'error', error: e.message });
  }
});

// A hawker requests a new area that isn't in the picker yet.
// This does NOT add it to the live list automatically — it queues it for
// whoever administers areas.json to review and add (prevents spam/duplicate
// near-identical entries from fragmenting the real list).
app.post('/api/area-requests', async (req, res) => {
  try {
    const { requested_name, phone } = req.body;
    if (!requested_name || !requested_name.trim()) {
      return res.status(400).json({ error: 'requested_name is required' });
    }
    await pool.query(
      `INSERT INTO area_requests (requested_name, phone, status, created_at) VALUES ($1, $2, 'pending', $3)`,
      [requested_name.trim(), phone ? normalizePhone(phone) : null, Date.now()]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});

// Admin view: list pending area requests so you know what to add to areas.json.
// NOTE: this has no authentication in v1 — anyone with the server URL can see it.
// Fine for a small pilot; needs a login before wider rollout.
app.get('/api/area-requests', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM area_requests WHERE status = 'pending' ORDER BY created_at DESC`
    );
    const requests = result.rows.map(r => ({ ...r, created_at: Number(r.created_at) }));
    res.json({ requests });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});

// Admin action: mark a request as dismissed without adding it as an area
// (e.g. duplicate, spam, or not a real locality). Use "approve" below instead
// when you actually want it added.
app.post('/api/area-requests/:id/resolve', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await pool.query(`UPDATE area_requests SET status = 'resolved' WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});

// Admin action: actually adds a new area (immediately live — no redeploy needed)
// and, if requestId is given, marks that area request as resolved in the same call.
app.post('/api/admin/areas/approve', async (req, res) => {
  try {
    const { en, hi, mr, requestId } = req.body;
    if (!en || !en.trim()) {
      return res.status(400).json({ error: 'English name is required' });
    }
    const id = slugifyAreaName(en);
    const entry = {
      id,
      en: en.trim(),
      hi: (hi && hi.trim()) || en.trim(),
      mr: (mr && mr.trim()) || en.trim(),
    };

    await pool.query(
      'INSERT INTO areas (id, en, hi, mr, created_at) VALUES ($1, $2, $3, $4, $5)',
      [entry.id, entry.en, entry.hi, entry.mr, Date.now()]
    );
    AREAS.push(entry); // update the in-memory cache immediately

    if (requestId) {
      await pool.query(`UPDATE area_requests SET status = 'resolved' WHERE id = $1`, [Number(requestId)]);
    }

    res.json({ ok: true, area: entry });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});

// Admin action: wipe ALL hawkers, alerts, and area requests. Meant for clearing
// out test data before a real rollout. NOTE: no authentication in v1 — same caveat
// as the rest of the admin endpoints; fine for a small trusted pilot only.
app.post('/api/admin/reset', async (req, res) => {
  try {
    await pool.query('DELETE FROM alerts');
    await pool.query('DELETE FROM hawkers');
    await pool.query('DELETE FROM area_requests');
    await pool.query('DELETE FROM push_subscriptions');
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});

// Admin view: list every registered hawker, with their area's display label attached,
// so individual test/unwanted entries can be reviewed and removed one at a time
// instead of wiping everyone.
app.get('/api/admin/hawkers', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT h.*, (ps.phone IS NOT NULL) as has_push
      FROM hawkers h
      LEFT JOIN push_subscriptions ps ON ps.phone = h.phone
      ORDER BY h.area, h.name
    `);
    const hawkers = result.rows.map(h => ({
      ...h,
      created_at: Number(h.created_at),
      areaLabel: findArea(h.area) || null,
      hasPush: h.has_push
    }));
    res.json({ hawkers });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});

// Admin action: delete one specific hawker by id (also removes their push
// subscription, if any, so it doesn't linger as an orphaned row).
app.delete('/api/admin/hawkers/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await pool.query('SELECT phone FROM hawkers WHERE id = $1', [id]);
    if (!row.rows.length) return res.status(404).json({ error: 'not found' });
    const phone = row.rows[0].phone;

    await pool.query('DELETE FROM hawkers WHERE id = $1', [id]);
    await pool.query('DELETE FROM push_subscriptions WHERE phone = $1', [phone]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});

initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Hawker Alert server running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });
