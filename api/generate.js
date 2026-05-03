export default async function handler(req, res) {
  // ── CORS ──
  res.setHeader('Access-Control-Allow-Origin', 'https://propscribe.one');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 1. VERIFY AUTH TOKEN ──
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated. Please sign in.' });
  }

  const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'apikey': process.env.SUPABASE_ANON_KEY,
    },
  });

  if (!userRes.ok) {
    return res.status(401).json({ error: 'Invalid session. Please sign in again.' });
  }

  const user = await userRes.json();
  const userId = user.id;

  // ── 2. CHECK USAGE SERVER-SIDE ──
  const profileRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=generations_used,plan`,
    {
      headers: {
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
      },
    }
  );

  if (!profileRes.ok) {
    return res.status(500).json({ error: 'Could not verify your account. Please try again.' });
  }

  const profiles = await profileRes.json();
  const profile = profiles[0];

  if (!profile) {
    return res.status(404).json({ error: 'Profile not found. Please sign out and back in.' });
  }

  const isPaid = profile.plan && profile.plan !== 'free';
  const used = profile.generations_used || 0;

  if (!isPaid && used >= 3) {
    return res.status(403).json({ error: 'free_limit_reached' });
  }

  // ── 3. SANITISE INPUT ──
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'No prompt provided.' });
  }

  const injectionPatterns = [
    /ignore (all )?(previous|prior|above) instructions/gi,
    /disregard (all )?(previous|prior|above)/gi,
    /forget (all )?(previous|prior|above)/gi,
    /you are now/gi,
    /new persona/gi,
    /system prompt/gi,
    /jailbreak/gi,
    /DAN mode/gi,
    /pretend you/gi,
    /act as if/gi,
  ];

  for (const pattern of injectionPatterns) {
    if (pattern.test(prompt)) {
      return res.status(400).json({ error: 'Invalid input detected.' });
    }
  }

  if (prompt.length > 6000) {
    return res.status(400).json({ error: 'Input too long. Please shorten your property details.' });
  }

  // ── 4. INCREMENT USAGE BEFORE API CALL ──
  if (!isPaid) {
    const incrementRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ generations_used: used + 1 }),
      }
    );

    if (!incrementRes.ok) {
      return res.status(500).json({ error: 'Could not update usage. Please try again.' });
    }
  }

  // ── 5. CALL ANTHROPIC ──
  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 2000,
        stream: true,
        system: `You are an expert real estate copywriter with deep knowledge of property markets worldwide.
Write compelling, specific, authentic listing copy.
NEVER use: stunning, beautiful (as filler), nestled, boasts, perfect, dream home, don't miss, sought-after, makes an impression, those who appreciate, seamless, elevate, luxurious (overused).
NEVER start with "Welcome to" or "Introducing".
Always be specific. Use actual features, not vague descriptors.
Write as if you know the property intimately.`,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json().catch(() => ({}));
      // Refund generation on Anthropic failure
      if (!isPaid) {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
          method: 'PATCH',
          headers: {
            'apikey': process.env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify({ generations_used: used }),
        });
      }
      return res.status(anthropicRes.status).json({
        error: err?.error?.message || 'AI service error. Please try again.'
      });
    }

    // Stream back to client
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send usage update to client
    res.write(`data: {"type":"usage","used":${isPaid ? used : used + 1},"limit":${isPaid ? 999999 : 3}}\n\n`);

    const reader = anthropicRes.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }

    res.end();

  } catch (err) {
    // Refund on unexpected error
    if (!isPaid) {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
        method: 'PATCH',
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ generations_used: used }),
      });
    }
    return res.status(500).json({ error: err.message || 'Unexpected error. Please try again.' });
  }
}
