// Session automation: meeting link + calendar invite when a booking is paid,
// and the AI prep brief used in the day-before reminder.
const M = require('./_mail');
const MT = require('./_meeting');
const AI = require('./_ai');

const svcHeaders = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' });

// Called by the Stripe webhook after a booking is marked paid.
// Safe to call twice: the link is only created (and emails only sent) the first time.
async function confirmPaidSession(requestId) {
  const meeting = MT.createMeeting();
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/requests?id=eq.${encodeURIComponent(requestId)}&meetingUrl=is.null`, {
    method: 'PATCH',
    headers: Object.assign({ Prefer: 'return=representation' }, svcHeaders()),
    body: JSON.stringify({ meetingUrl: meeting.url, meetingRoom: meeting.room })
  });
  let r;
  if (res.ok) {
    const updated = await res.json();
    if (!updated.length) return { skipped: 'already-confirmed' }; // Stripe re-sent the webhook
    r = updated[0];
  } else {
    // The meetingUrl column doesn't exist yet (SQL not run): still send the emails with the old-style link.
    console.error('meeting-link-save-failed', res.status, await res.text());
    r = (await M.rows(`requests?id=eq.${encodeURIComponent(requestId)}&select=*`))[0];
    if (!r) return { skipped: 'no-request' };
  }
  await sendConfirmation(r);
  return { ok: true };
}

async function sendConfirmation(r, opts = {}) {
  const url = MT.meetingUrlFor(r);
  const [mentor, client] = await Promise.all([M.profile(r.mentorId), M.profile(r.clientId)]);
  const site = M.SITE();
  const people = [
    { me: mentor, other: client, isMentor: true },
    { me: client, other: mentor, isMentor: false }
  ];
  for (const p of people) {
    const title = `Workar session with ${p.other.name || 'your ' + (p.isMentor ? 'client' : 'mentor')}`;
    const description = p.isMentor
      ? `Mentoring session with ${p.other.name}.${r.message ? ' Their note: ' + String(r.message).slice(0, 300) : ''}`
      : `Mentoring session with ${p.other.name}. We recommend preparing your questions and testing your camera and microphone a few minutes before you join.`;
    const ics = MT.buildIcs({ r, title, description, url });
    const gcal = MT.googleCalendarLink({ r, title, description, url });
    const whenTxt = M.when(r, p.me.timezone);
    const subject = opts.updated
      ? `Updated time: your Workar session with ${p.other.name}`
      : (p.isMentor ? `${p.other.name} paid, your session is confirmed` : `You're booked with ${p.other.name}`);
    const paras = [
      opts.updated
        ? `Your session with <b>${M.esc(p.other.name)}</b> is now on <b>${M.esc(whenTxt)}</b>.`
        : (p.isMentor
          ? `<b>${M.esc(p.other.name)}</b> completed payment. Your session is confirmed for <b>${M.esc(whenTxt)}</b>.`
          : `Your session with <b>${M.esc(p.other.name)}</b> is confirmed for <b>${M.esc(whenTxt)}</b>.`),
      `Your private call link: ${M.link(url, url)}<br><span style="font-size:13px;color:#8a7461;">You can also join from your Workar dashboard. The first person to join may be asked to sign in with Google or GitHub to open the room.</span>`,
      gcal ? `${M.link(gcal, 'Add to Google Calendar')}, or open the attached invite to add it to Outlook or Apple Calendar. The invite reminds you 1 hour and 15 minutes before.` : '',
      p.isMentor ? 'The day before, we will email you a short prep brief about your client.' : 'The day before, we will email you a few tips to get the most out of the session.'
    ];
    await M.sendMail(await M.emailOf(p.me.id), subject, M.layout(opts.updated ? 'Your session time changed' : 'Session confirmed', paras, { text: 'Join the call', url }), MT.icsAttachment(ics));
  }
}

// Calendar cancellation for both people when a paid session is cancelled.
async function sendCancellationInvite(r) {
  if (!r.startsAt) return;
  const [mentor, client] = await Promise.all([M.profile(r.mentorId), M.profile(r.clientId)]);
  for (const [me, other] of [[mentor, client], [client, mentor]]) {
    const ics = MT.buildIcs({ r, title: `Workar session with ${other.name}`, description: 'This session was cancelled.', cancelled: true });
    await M.sendMail(await M.emailOf(me.id), `Calendar update: session with ${other.name} cancelled`,
      M.layout('Remove this from your calendar', [`The session with <b>${M.esc(other.name)}</b> on <b>${M.esc(M.when(r, me.timezone))}</b> was cancelled. Open the attached file to remove it from your calendar.`]), MT.icsAttachment(ics));
  }
}

// ---------- Session prep agent ----------
function clientSummary(c) {
  const bits = {
    targetRole: c.profession, currentRole: c.currentProfession, careerStage: c.careerStage, targetField: c.targetField,
    goals: c.goals, aboutTheirGoal: c.bio, education: c.education, certifications: c.certifications, skills: c.skills
  };
  Object.keys(bits).forEach(k => { const v = bits[k]; if (v == null || v === '' || (Array.isArray(v) && !v.length)) delete bits[k]; });
  return bits;
}

async function makePrepBrief(r) {
  const [mentor, client, thread] = await Promise.all([
    M.fullProfile(r.mentorId), M.fullProfile(r.clientId),
    M.rows(`messages?requestId=eq.${encodeURIComponent(r.id)}&select=senderId,text,createdAt&order=createdAt.asc&limit=30`)
  ]);
  const chat = thread.map(m => `${m.senderId === r.mentorId ? 'Mentor' : 'Client'}: ${String(m.text).slice(0, 400)}`).join('\n');
  const input = {
    mentor: { name: mentor.name, profession: mentor.profession, headline: mentor.headline, skills: mentor.skills, yearsExperience: mentor.experience },
    client: Object.assign({ firstName: String(client.name || '').split(' ')[0] }, clientSummary(client)),
    booking: { package: r.packageKey, sessionNumber: (Number(r.sessionsDone) || 0) + 1, noteFromClient: r.message || '' },
    chatBeforeSession: chat || '(none)'
  };
  const brief = await AI.askJSON(
    `You prepare Workar mentors and clients for a 45-minute career mentoring session.
Use only the information given. Never invent facts about the client. If information is thin, say what the mentor should ask.
Return: {"goal": one sentence on what the client most likely wants from this session,
"context": up to 3 short facts about the client that matter for this session,
"agenda": 3 short agenda items that fit 45 minutes,
"firstQuestion": one good opening question for the mentor to ask,
"clientTips": 3 short, specific tips for the client to prepare (addressed to the client as "you")}.
Plain English, short sentences.`,
    JSON.stringify(input), { maxTokens: 700, timeoutMs: 20000 });
  return {
    goal: String(brief.goal || '').slice(0, 300),
    context: (brief.context || []).slice(0, 3).map(x => String(x).slice(0, 200)),
    agenda: (brief.agenda || []).slice(0, 4).map(x => String(x).slice(0, 200)),
    firstQuestion: String(brief.firstQuestion || '').slice(0, 300),
    clientTips: (brief.clientTips || []).slice(0, 3).map(x => String(x).slice(0, 250)),
    createdAt: new Date().toISOString()
  };
}

module.exports = { confirmPaidSession, sendConfirmation, sendCancellationInvite, makePrepBrief };
