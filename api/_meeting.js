process.env.SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://jgbjhzhbdsdhssyakpgq.supabase.co').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, ''); // tolerate a URL saved with /rest/v1
// Video meeting + calendar helpers. Swap the video provider here (Daily, Whereby, JaaS...)
// and every email, reminder and dashboard button follows automatically.
const crypto = require('crypto');

const SESSION_MINUTES = () => Number(process.env.SESSION_MINUTES) || 30; // matches SESSION_MIN in index.html

// A private, hard-to-guess room for each paid booking.
// With DAILY_API_KEY set, calls run on Daily (inside Workar, no sign-in); otherwise Jitsi.
const isDaily = url => /\.daily\.co\//i.test(String(url || ''));
const EARLY_JOIN_MIN = () => Number(process.env.EARLY_JOIN_MINUTES) || 5;

// The call opens a few minutes before the booked start and everyone is removed
// when the session length (SESSION_MINUTES, default 30) is up.
function callWindow(r, now = Date.now()) {
  const booked = r && r.startsAt ? new Date(r.startsAt).getTime() : NaN;
  const start = Number.isFinite(booked) ? booked : now;
  const sec = t => Math.floor(t / 1000);
  const end = Math.max(start + SESSION_MINUTES() * 60000, now + 5 * 60000); // never create an already-expired room
  const props = { exp: sec(end), eject_at_room_exp: true };
  if (Number.isFinite(booked) && booked - EARLY_JOIN_MIN() * 60000 > now) props.nbf = sec(booked - EARLY_JOIN_MIN() * 60000);
  return props;
}

async function createMeeting(r) {
  const room = 'Workar-' + crypto.randomBytes(12).toString('base64url');
  const key = process.env.DAILY_API_KEY;
  if (key) {
    try {
      const res = await fetch('https://api.daily.co/v1/rooms', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: room.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40), privacy: 'public',
          properties: Object.assign({ max_participants: 4, enable_chat: true, enable_screenshare: true, enable_prejoin_ui: false, lang: 'en' }, callWindow(r)) })
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.url) return { room: d.name, url: d.url };
      console.error('daily-room-failed', res.status, JSON.stringify(d).slice(0, 300));
    } catch (e) { console.error('daily-room-failed', e.message); }
  }
  return { room, url: 'https://meet.jit.si/' + room };
}

// When a paid session is moved, move the Daily room's open/close times with it.
async function rescheduleMeeting(r) {
  const key = process.env.DAILY_API_KEY;
  if (!key || !isDaily(r && r.meetingUrl)) return { skipped: true };
  const name = r.meetingRoom || String(r.meetingUrl).split('/').pop().split('?')[0];
  const props = callWindow(r);
  if (!props.nbf) props.nbf = null; // clear an old opening time if the new start is now or past
  try {
    const res = await fetch('https://api.daily.co/v1/rooms/' + encodeURIComponent(name), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: props })
    });
    if (!res.ok) console.error('daily-room-update-failed', res.status, (await res.text()).slice(0, 300));
    return { ok: res.ok };
  } catch (e) { console.error('daily-room-update-failed', e.message); return { ok: false }; }
}

// Older bookings (paid before this update) used a room named after the request id.
function meetingUrlFor(r) {
  const url = r.meetingUrl || ('https://meet.jit.si/Workar-Session-' + encodeURIComponent(r.id));
  if (isDaily(url)) return url;
  // English call screen by default (Jitsi otherwise follows the browser's language)
  return url + '?lang=en#config.defaultLanguage=%22en%22';
}

function icsStamp(d) { return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function icsText(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;'); }
function fold(line) { // RFC 5545: 75 UTF-8 octets, without splitting a code point
  const lines = []; let current = '', bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > 75) { lines.push(current); current = ' '; bytes = 1; }
    current += char; bytes += size;
  }
  lines.push(current); return lines.join('\r\n');
}

// .ics calendar file with alerts 1 hour and 15 minutes before the session.
function buildIcs({ r, title, description, url, cancelled = false }) {
  if (!r.startsAt || !Number.isFinite(new Date(r.startsAt).getTime())) return null;
  const start = new Date(r.startsAt);
  const end = new Date(start.getTime() + SESSION_MINUTES() * 60000);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Workar//Sessions//EN', 'CALSCALE:GREGORIAN',
    'METHOD:' + (cancelled ? 'CANCEL' : 'PUBLISH'),
    'BEGIN:VEVENT',
    'UID:' + icsText(r.id) + '@workar.me',
    'SEQUENCE:' + Math.floor(Date.now() / 1000),
    'DTSTAMP:' + icsStamp(Date.now()),
    'DTSTART:' + icsStamp(start),
    'DTEND:' + icsStamp(end),
    'SUMMARY:' + icsText(title),
    'DESCRIPTION:' + icsText(description + (url ? '\n\nJoin: ' + url : '')),
    url ? 'LOCATION:' + icsText(url) : null,
    url ? 'URL:' + String(url).replace(/[\r\n]/g, '') : null,
    'STATUS:' + (cancelled ? 'CANCELLED' : 'CONFIRMED')
  ].filter(Boolean);
  if (!cancelled) {
    for (const mins of [60, 15]) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText(title), 'TRIGGER:-PT' + mins + 'M', 'END:VALARM');
    }
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

function icsAttachment(ics) {
  return ics ? [{ filename: 'workar-session.ics', content: Buffer.from(ics).toString('base64') }] : [];
}

function googleCalendarLink({ r, title, description, url }) {
  if (!r.startsAt || !Number.isFinite(new Date(r.startsAt).getTime())) return null;
  const start = new Date(r.startsAt), end = new Date(start.getTime() + SESSION_MINUTES() * 60000);
  const p = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: icsStamp(start) + '/' + icsStamp(end), details: description + (url ? '\n\nJoin: ' + url : ''), location: url || '' });
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}

// ---------- Attendance (money decisions) ----------
// Did BOTH people join the call for one session? Used before charging the client and before paying
// the mentor for each session. Matches Daily participants by the display name Workar joins them with.
//   both | mentor-absent | client-absent | none | unclear | unavailable (no Daily record: never blocks money)
const PRESENT_MIN = 5; // minutes in the call to count as present
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
function classifyAttendance(meetings, names = {}, startMs = NaN) {
  const lo = Number.isFinite(startMs) ? startMs / 1000 - 30 * 60 : -Infinity, hi = Number.isFinite(startMs) ? startMs / 1000 + 3 * 3600 : Infinity;
  const mins = {};
  for (const m of meetings || []) {
    for (const p of m.participants || []) {
      const t = Number(p.join_time) || Number(m.start_time) || 0;
      if (t && (t < lo || t > hi)) continue; // a different session of the same package
      const k = norm(p.user_name) || '(unnamed)';
      mins[k] = (mins[k] || 0) + (Number(p.duration) || 0) / 60;
    }
  }
  const mentor = norm(names.mentor), client = norm(names.client);
  const present = Object.keys(mins).filter(k => mins[k] >= PRESENT_MIN);
  const m = !!mentor && present.includes(mentor), c = !!client && present.includes(client) && client !== mentor;
  const others = present.filter(k => k !== mentor && k !== client);
  const minutes = Object.keys(mins).map(k => `${k}: ${Math.round(mins[k])} min`).join(', ') || 'nobody joined';
  let status;
  if (m && c) status = 'both';
  else if (!present.length) status = 'none';
  else if (others.length) status = 'unclear';
  else status = m ? 'client-absent' : 'mentor-absent';
  return { status, note: minutes };
}

async function sessionAttendance(r, startsAt, names) {
  if (!r || !r.meetingUrl || !isDaily(r.meetingUrl)) return { status: 'unavailable', note: 'no Daily call record (Jitsi or no link)' };
  if (!process.env.DAILY_API_KEY) return { status: 'unavailable', note: 'DAILY_API_KEY is not set' };
  const start = startsAt ? Date.parse(startsAt) : NaN;
  const room = r.meetingRoom || String(r.meetingUrl).split('/').pop().split('?')[0];
  const q = new URLSearchParams({ room, limit: '100' });
  if (Number.isFinite(start)) { q.set('timeframe_start', String(Math.floor(start / 1000) - 3600)); q.set('timeframe_end', String(Math.floor(start / 1000) + 4 * 3600)); }
  try {
    const res = await fetch('https://api.daily.co/v1/meetings?' + q.toString(), { headers: { Authorization: 'Bearer ' + process.env.DAILY_API_KEY } });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return { status: 'unavailable', note: 'Daily answered ' + res.status };
    return classifyAttendance(d.data || [], names, start);
  } catch (e) { return { status: 'unavailable', note: 'Daily could not be reached: ' + String(e.message || e).slice(0, 100) }; }
}

module.exports = { SESSION_MINUTES, isDaily, callWindow, createMeeting, rescheduleMeeting, meetingUrlFor, buildIcs, icsAttachment, googleCalendarLink, classifyAttendance, sessionAttendance };
