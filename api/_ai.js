// Shared helper for Workar's AI agents (not a route: files starting with "_" are not deployed as functions).
// Uses ANTHROPIC_API_KEY (already set for api/ai.js). Optional: ANTHROPIC_MODEL.
const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

async function callClaude({ system, messages, tools, maxTokens = 1000, timeoutMs = 25000 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = { model: MODEL(), max_tokens: maxTokens, system, messages };
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

// Ask for JSON only, and parse it even if the model wraps it in ``` fences.
async function askJSON(system, userText, opts = {}) {
  const data = await callClaude(Object.assign({ system: system + '\n\nRespond with valid JSON only. No markdown, no code fences, no commentary.', messages: [{ role: 'user', content: userText }] }, opts));
  const raw = textOf(data).replace(/```json|```/g, '').trim();
  const start = raw.search(/[\[{]/);
  const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  return JSON.parse(raw.slice(start, end + 1));
}

module.exports = { MODEL, callClaude, textOf, askJSON };
