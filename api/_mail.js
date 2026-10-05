// Shared helpers for Workar emails (not a route: files starting with "_" are not deployed as functions).
// Environment Variables in Vercel:
//   RESEND_API_KEY            — from resend.com (free plan is enough to start)
//   MAIL_FROM                 — e.g. "Workar <notifications@workar.me>" (domain verified in Resend)
//   SITE_URL                  — e.g. https://workar.me
//   ADMIN_EMAIL               — where new mentor applications are sent
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (already set)

const SITE = () => (process.env.SITE_URL || 'https://workar.me').replace(/\/$/, '');
const svc = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' });
const SB = () => process.env.SUPABASE_URL;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function userFromToken(token) {
  if (!token) return null;
  const r = await fetch(`${SB()}/auth/v1/user`, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + token } });
  if (!r.ok) return null;
  return r.json();
}
async function emailOf(userId) {
  const r = await fetch(`${SB()}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { headers: svc() });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.email;
}
async function rows(path) {
  const r = await fetch(`${SB()}/rest/v1/${path}`, { headers: svc() });
  if (!r.ok) return [];
  return r.json();
}
async function patch(path, body) {
  return fetch(`${SB()}/rest/v1/${path}`, { method: 'PATCH', headers: Object.assign({ Prefer: 'return=minimal' }, svc()), body: JSON.stringify(body) });
}
async function fullProfile(id) { const p = await rows(`profiles?id=eq.${encodeURIComponent(id)}&select=*`); return p[0] || { id, name: 'Someone' }; }
async function profile(id) { const p = await rows(`profiles?id=eq.${encodeURIComponent(id)}&select=id,name,role,timezone`); return p[0] || { id, name: 'Someone' }; }

// "Sat, Oct 3 at 6:00 PM PDT", shown in the recipient's own time zone when we know it
function when(req, tz) {
  try {
    if (req.startsAt) {
      return new Date(req.startsAt).toLocaleString('en-US', { timeZone: tz || req.tz || 'America/Vancouver', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    }
  } catch (e) {}
  return [req.date, req.time].filter(Boolean).join(' at ');
}

function layout(title, paragraphs, cta) {
  const p = paragraphs.filter(Boolean).map(x => /^<(ul|h3|div)/.test(x) ? `<div style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#5B4433;">${x}</div>` : `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#5B4433;">${x}</p>`).join('');
  const button = cta ? `<p style="margin:22px 0 6px;"><a href="${cta.url}" style="display:inline-block;background:#8B6A4C;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:999px;">${esc(cta.text)}</a></p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#F7F1E9;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F1E9;padding:28px 12px;"><tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#fff;border:1px solid #EAE0D2;border-radius:16px;">
  <tr><td style="padding:26px 30px 8px;font-size:12px;letter-spacing:4px;font-weight:700;color:#A88660;">WORKAR</td></tr>
  <tr><td style="padding:6px 30px 26px;"><h1 style="margin:0 0 16px;font-size:21px;line-height:1.3;color:#4A3526;">${esc(title)}</h1>${p}${button}</td></tr>
  </table>
  <p style="font-size:12px;color:#A88660;margin:16px 0 0;">Workar · career mentoring · <a href="${SITE()}" style="color:#A88660;">workar.me</a></p>
  </td></tr></table></body></html>`;
}

async function sendMail(to, subject, html, attachments) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return { skipped: true };
  const payload = { from: process.env.MAIL_FROM || 'Workar <notifications@workar.me>', to: [to], subject, html };
  if (attachments && attachments.length) payload.attachments = attachments; // [{ filename, content (base64) }]
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) console.error('resend-error', r.status, await r.text());
  return { ok: r.ok };
}

function link(url, text) { return `<a href="${esc(url)}" style="color:#8B6A4C;font-weight:700;">${esc(text)}</a>`; }
function list(items) { const li = (items || []).filter(Boolean).map(x => `<li style="margin:0 0 6px;">${esc(x)}</li>`).join(''); return li ? `<ul style="margin:0;padding-left:20px;">${li}</ul>` : ''; }

module.exports = { SITE, esc, userFromToken, emailOf, rows, patch, profile, fullProfile, when, layout, sendMail, link, list };
