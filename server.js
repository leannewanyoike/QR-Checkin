/**
 * QR Check-in / Print Webhook Flow 

 *
 * Flow:
 *  1. QR scanned -> POST /api/check-in
 *  2. If attendee already pending/checked_in, do nothing (no duplicate print job)
 *  3. Otherwise, publish a print request to the vendor's queue, mark attendee 'pending'
 *  4. Vendor prints the badge, then calls POST /webhooks/printer when done
 *  5. Webhook marks the attendee 'checked_in'
 *

 *
 * Run:
 *   node server.js
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3002;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'dev-secret-change-me';
const SIMULATED_PRINT_TIME_MS = Number(process.env.SIMULATED_PRINT_TIME_MS) || 3000;

// ---------- in-memory "database" ----------

const STATUS = {
  NOT_CHECKED_IN: 'not_checked_in',
  PENDING: 'pending',
  CHECKED_IN: 'checked_in',
};

// Pre-registered attendees for the demo. In a real system this would be
// seeded from your registration database.
const attendees = new Map([
  ['A100', { id: 'A100', name: 'Jane Doe', status: STATUS.NOT_CHECKED_IN, printJobId: null }],
  ['A101', { id: 'A101', name: 'John Smith', status: STATUS.NOT_CHECKED_IN, printJobId: null }],
  ['A102', { id: 'A102', name: 'Alex Kim', status: STATUS.NOT_CHECKED_IN, printJobId: null }],
]);

// Tracks in-flight print jobs so the webhook can find who a job belongs to,
// and so we can ignore a webhook retry for a job we already finished.
const printJobs = new Map(); // jobId -> { attendeeId, status: 'queued'|'completed'|'failed' }

function getOrRegisterAttendee(id) {
  if (!attendees.has(id)) {
    // Prototype convenience: auto-register unknown badge IDs instead of
    // 404ing, so you can test with any ID. In production you'd likely
    // reject unknown attendees instead.
    attendees.set(id, { id, name: null, status: STATUS.NOT_CHECKED_IN, printJobId: null });
  }
  return attendees.get(id);
}

// ---------- helpers ----------

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(); // 1MB guard
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function signPayload(rawBody) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

function verifySignature(rawBody, signature) {
  if (!signature) return false;
  const expected = signPayload(rawBody);
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false; // length mismatch etc.
  }
}

// ---------- simulated vendor print queue ----------

function publishPrintRequest(attendeeId, jobId) {
  printJobs.set(jobId, { attendeeId, status: 'queued' });
  console.log(`[vendor-queue] print job ${jobId} queued for ${attendeeId}`);

  // Simulate the vendor's printer doing the job, then calling us back --
  // exactly like a real vendor webhook would, over real HTTP.
  setTimeout(() => {
    const rawBody = JSON.stringify({ jobId, attendeeId, status: 'completed' });
    const signature = signPayload(rawBody);

    const req = http.request(
      {
        host: 'localhost',
        port: PORT,
        path: '/webhooks/printer',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(rawBody),
          'X-Webhook-Signature': signature,
        },
      },
      (res) => {
        res.on('data', () => {}); // drain
      }
    );
    req.on('error', (err) => console.error('[vendor-queue] callback failed:', err.message));
    req.write(rawBody);
    req.end();
  }, SIMULATED_PRINT_TIME_MS);
}

// ---------- route handlers ----------

async function handleCheckIn(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return sendJSON(res, 400, { error: 'invalid JSON body' });
  }

  const { attendeeId } = body;
  if (!attendeeId) {
    return sendJSON(res, 400, { error: 'attendeeId is required' });
  }

  const attendee = getOrRegisterAttendee(attendeeId);

  if (attendee.status === STATUS.CHECKED_IN) {
    return sendJSON(res, 200, {
      attendeeId,
      status: attendee.status,
      message: 'Attendee already checked in. No new print job created.',
    });
  }

  if (attendee.status === STATUS.PENDING) {
    return sendJSON(res, 200, {
      attendeeId,
      status: attendee.status,
      printJobId: attendee.printJobId,
      message: 'Print job already in progress. No duplicate created.',
    });
  }

  // status is not_checked_in -> create a new print job
  const jobId = crypto.randomUUID();
  attendee.status = STATUS.PENDING;
  attendee.printJobId = jobId;

  publishPrintRequest(attendeeId, jobId);

  return sendJSON(res, 202, {
    attendeeId,
    status: attendee.status,
    printJobId: jobId,
    message: 'Print request published to vendor queue.',
  });
}

async function handlePrinterWebhook(req, res) {
  const raw = await readBody(req);
  const signature = req.headers['x-webhook-signature'];

  if (!verifySignature(raw, signature)) {
    return sendJSON(res, 401, { error: 'invalid or missing signature' });
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return sendJSON(res, 400, { error: 'invalid JSON body' });
  }

  const { jobId, attendeeId, status } = body;
  if (!jobId || !attendeeId || !status) {
    return sendJSON(res, 400, { error: 'jobId, attendeeId, and status are required' });
  }

  const job = printJobs.get(jobId);
  if (!job) {
    return sendJSON(res, 404, { error: 'unknown print job' });
  }

  if (job.attendeeId !== attendeeId) {
    return sendJSON(res, 400, { error: 'job does not belong to attendee' });
  }

  if (!['completed', 'failed'].includes(status)) {
    return sendJSON(res, 400, { error: `unrecognized status '${status}'` });
  }

  // Idempotency: if we already processed this job (e.g. vendor retried the
  // webhook), don't process it again.
  if (job.status !== 'queued') {
    return sendJSON(res, 200, { ok: true, note: 'job already processed, ignored duplicate webhook' });
  }

  const attendee = attendees.get(attendeeId);
  if (!attendee) {
    return sendJSON(res, 404, { error: 'unknown attendee' });
  }

  // A failed job may be retried before a delayed callback arrives. A stale
  // callback must never change the state of the newer job.
  if (attendee.printJobId !== jobId) {
    job.status = status;
    return sendJSON(res, 200, { ok: true, note: 'stale webhook ignored' });
  }

  if (status === 'completed') {
    job.status = 'completed';
    attendee.status = STATUS.CHECKED_IN;
    console.log(`[webhook] job ${jobId} completed -> ${attendeeId} is now checked_in`);
  } else if (status === 'failed') {
    job.status = 'failed';
    // Let them retry: reset to not_checked_in so a future scan creates a fresh job.
    attendee.status = STATUS.NOT_CHECKED_IN;
    attendee.printJobId = null;
    console.log(`[webhook] job ${jobId} failed -> ${attendeeId} reset to not_checked_in`);
  }

  return sendJSON(res, 200, { ok: true, attendeeId, status: attendee.status });
}

function handleGetAttendee(res, id) {
  const attendee = attendees.get(id);
  if (!attendee) {
    return sendJSON(res, 404, { error: 'attendee not found' });
  }
  return sendJSON(res, 200, attendee);
}

function handleKioskPage(res) {
  const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return handleKioskPage(res);
    }

    if (req.method === 'POST' && url.pathname === '/api/check-in') {
      return await handleCheckIn(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/webhooks/printer') {
      return await handlePrinterWebhook(req, res);
    }

    const attendeeMatch = url.pathname.match(/^\/api\/attendees\/([^/]+)$/);
    if (req.method === 'GET' && attendeeMatch) {
      return handleGetAttendee(res, decodeURIComponent(attendeeMatch[1]));
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJSON(res, 200, { ok: true, uptime: process.uptime() });
    }

    return sendJSON(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    return sendJSON(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`QR check-in service listening on http://localhost:${PORT}`);
  console.log(`Seeded attendees: ${[...attendees.keys()].join(', ')}`);
});
