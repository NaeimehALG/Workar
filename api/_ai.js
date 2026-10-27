process.env.SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://jgbjhzhbdsdhssyakpgq.supabase.co').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, ''); // tolerate a URL saved with /rest/v1
// Shared helper for Workar's AI agents (not a route: files starting with "_" are not deployed as functions).
// Uses ANTHROPIC_API_KEY (already set for api/ai.js). Optional: ANTHROPIC_MODEL.
// One voice for every Workar agent.
const TONE = `Voice and tone: courteous, warm and professional, like an experienced advisor at a respected career firm.
Use polite phrasing naturally ("please", "thank you", "would you like"). Address people respectfully and never sound casual or salesy.
No slang, no emojis, no exclamation marks, no filler praise. Be clear and concise.
In Persian, always use the formal "شما" form and polite verb endings. In French, use "vous".`;

const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

async function callClaude({ system, messages, tools, maxTokens = 1000, timeoutMs = 25000 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = { model: MODEL(), max_tokens: maxTokens, system: system + '\n\n' + TONE, messages };
    if (tools) body.tools = tools;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) throw new Error((data && data.error && data.error.message) || ('anthropic-error-' + r.status));
    return data;
  } finally { clearTimeout(timer); }
}

function textOf(data) {
  return ((data && data.content) || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

// Pull the first complete JSON object/array out of a model reply, ignoring any
// code fences or extra text (even extra text containing braces) around it.
function extractJSON(text) {
  const raw = String(text || '').replace(/```json|```/g, '').trim();
  for (let start = raw.search(/[\[{]/); start !== -1; ) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < raw.length; i++) {
      const c = raw[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        if (--depth === 0) {
          try { return JSON.parse(raw.slice(start, i + 1)); } catch (e) { break; }
        }
      }
    }
    const next = raw.slice(start + 1).search(/[\[{]/);
    start = next === -1 ? -1 : start + 1 + next;
  }
  throw new Error('no valid JSON in AI reply');
}

// Ask for JSON only, and parse it even if the model wraps it in ``` fences or adds
// commentary. One retry if the reply still can't be parsed.
async function askJSON(system, userText, opts = {}) {
  const sys = system + '\n\nRespond with exactly one valid JSON value only. No markdown, no code fences, no commentary before or after it.';
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const data = await callClaude(Object.assign({ system: sys, messages: [{ role: 'user', content: userText }] }, opts));
    try { return extractJSON(textOf(data)); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

module.exports = { TONE, MODEL, callClaude, textOf, askJSON, extractJSON };
