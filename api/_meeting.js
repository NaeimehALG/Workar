process.env.SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://jgbjhzhbdsdhssyakpgq.supabase.co').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, ''); // tolerate a URL saved with /rest/v1
// Video meeting + calendar helpers. Swap the video provider here (Daily, Whereby, JaaS...)
// and every email, reminder and dashboard button follows automatically.
const crypto = require('crypto');

const SESSION_MINUTES = () => Number(process.env.SESSION_MINUTES) || 45; // matches SESSION_MIN in index.html

// A private, hard-to-guess room for each paid booking.
function createMeeting() {
  const room = 'Workar-' + crypto.randomBytes(12).toString('base64url');
  return { room, url: 'https://meet.jit.si/' + room };
}

// Older bookings (paid before this update) used a room named after the request id.
function meetingUrlFor(r) {
  // English call screen by default (Jitsi otherwise follows the browser's language)
  return (r.meetingUrl || ('https://meet.jit.si/Workar-Session-' + encodeURIComponent(r.id))) + '#config.defaultLanguage=%22en%22';
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

module.exports = { SESSION_MINUTES, createMeeting, meetingUrlFor, buildIcs, icsAttachment, googleCalendarLink };
