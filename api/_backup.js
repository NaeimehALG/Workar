// Weekly off-site backup: every Sunday the daily cron emails the admin a gzipped JSON copy of all
// Workar tables plus each member's sign-in email. Supabase (Pro) already keeps 7 daily backups;
// this copy lives outside Supabase, in the admin's inbox, so the data survives even if the project is lost.
// Restore: unzip, then insert each table's rows back (Supabase Table Editor → Import, or the REST API).
const zlib = require('zlib');
const M = require('./_mail');

const TABLES = ['profiles', 'requests', 'messages', 'reviews', 'mentor_payout_accounts', 'stripe_customers',
  'dispute_statements', 'safety_reports', 'blocks', 'support_tickets', 'site_settings', 'ai_credit_purchases',
  'exams', 'exam_questions', 'exam_attempts', 'exam_purchases', 'linkedin_queue', 'agent_events'];
const PAGE = 1000;

const svc = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY });

async function tableRows(table) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?select=*`, { headers: { ...svc(), Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items' } });
    if (!r.ok) { if (r.status === 404) return null; throw new Error(`${table}: HTTP ${r.status}`); }
    const page = await r.json();
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

async function members() {
  const out = [];
  for (let page = 1; page < 100; page++) {
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=500`, { headers: svc() });
    if (!r.ok) throw new Error('auth users: HTTP ' + r.status);
    const j = await r.json();
    const users = j.users || [];
    for (const u of users) if (!u.is_anonymous) out.push({ id: u.id, email: u.email, createdAt: u.created_at, lastSignIn: u.last_sign_in_at });
    if (users.length < 500) return out;
  }
  return out;
}

async function snapshot() {
  const data = { takenAt: new Date().toISOString(), tables: {}, members: [] };
  const counts = {}, problems = [];
  for (const t of TABLES) {
    try { const rows = await tableRows(t); if (rows) { data.tables[t] = rows; counts[t] = rows.length; } }
    catch (e) { problems.push(e.message); }
  }
  try { data.members = await members(); counts.members = data.members.length; } catch (e) { problems.push(e.message); }
  return { data, counts, problems };
}

function isBackupDay(now = new Date()) { return now.getUTCDay() === 0; } // Sunday

async function run(problems, { force = false, now = new Date() } = {}) {
  if (!force && !isBackupDay(now)) return { backup: 'not today' };
  const to = process.env.ADMIN_EMAIL || 'naeimeh.alaghehband@gmail.com';
  const snap = await snapshot();
  problems.push(...snap.problems.map(p => 'Backup: ' + p));
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(snap.data)));
  const day = snap.data.takenAt.slice(0, 10);
  const rowsTxt = Object.entries(snap.counts).filter(([, n]) => n).map(([t, n]) => `${t}: ${n}`);
  const sent = await M.sendMail(to, `Workar weekly backup ${day}`, M.layout('Your weekly Workar backup', [
    `Attached is a full copy of Workar's data from ${M.esc(day)} (${Math.ceil(gz.length / 1024)} KB, gzipped JSON).`,
    M.list(rowsTxt),
    'Keep this email. Supabase also keeps its own daily backups for 7 days; this copy is your extra safety net outside Supabase.',
    snap.problems.length ? `<b>Some tables could not be copied:</b> ${M.esc(snap.problems.join('; '))}` : ''
  ].filter(Boolean)), [{ filename: `workar-backup-${day}.json.gz`, content: gz.toString('base64') }]);
  if (sent && sent.ok === false) problems.push('Backup email failed to send');
  return { backupKB: Math.ceil(gz.length / 1024), backupTables: Object.keys(snap.data.tables).length };
}

module.exports = { run, snapshot, isBackupDay, TABLES };
