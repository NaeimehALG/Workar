// Vercel Serverless Function: proxies AI calls to Anthropic, keeping the API key server-side.
// Set ANTHROPIC_API_KEY as an Environment Variable in your Vercel project settings.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { turns, prompt } = body || {};

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server' });
    return;
  }

  try {
    const messages = turns
      ? turns.map(t => ({ role: t.role === 'user' ? 'user' : 'assistant', content: t.content }))
      : [{ role: 'user', content: prompt }];

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, messages })
    });

    if (!r.ok) {
      const errText = await r.text();
      res.status(502).json({ error: 'anthropic-error', detail: errText });
      return;
    }

    const data = await r.json();
    const text = (data.content || []).map(b => b.text || '').join('\n');
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
