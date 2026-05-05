export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://propscribe.one');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── AUTH ──
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Not authenticated. Please sign in.' });

  const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': process.env.SUPABASE_ANON_KEY },
  });
  if (!userRes.ok) return res.status(401).json({ error: 'Invalid session. Please sign in again.' });
  const user = await userRes.json();
  const userId = user.id;

  // ── GET PROFILE ──
  const profileRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=points,plan`,
    { headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}` } }
  );
  if (!profileRes.ok) return res.status(500).json({ error: 'Could not verify your account.' });

  const profiles = await profileRes.json();
  const profile = profiles[0];
  if (!profile) return res.status(404).json({ error: 'Profile not found. Please sign out and back in.' });

  const points = profile.points || 0;
  const COST = 10; // points per generation

  if (points < COST) {
    return res.status(403).json({ error: 'insufficient_points' });
  }

  // ── SANITISE INPUT ──
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'No prompt provided.' });

  const injectionPatterns = [
    /ignore (all )?(previous|prior|above) instructions/gi,
    /disregard (all )?(previous|prior|above)/gi,
    /you are now/gi,
    /system prompt/gi,
    /jailbreak/gi,
    /DAN mode/gi,
  ];
  for (const p of injectionPatterns) {
    if (p.test(prompt)) return res.status(400).json({ error: 'Invalid input detected.' });
  }
  if (prompt.length > 6000) return res.status(400).json({ error: 'Input too long.' });

  // ── DEDUCT POINTS BEFORE API CALL ──
  const deductRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`,
    {
      method: 'PATCH',
      headers: {
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ points: points - COST }),
    }
  );
  if (!deductRes.ok) return res.status(500).json({ error: 'Could not deduct points. Please try again.' });

  // ── CALL ANTHROPIC ──
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
NEVER use: stunning, beautiful (as filler), nestled, boasts, perfect, dream home, don't miss, sought-after, makes an impression, those who appreciate, seamless, elevate.
NEVER start with "Welcome to" or "Introducing".
Always be specific — use actual features, not vague descriptors.`,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      // Refund points on Anthropic failure
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
        method: 'PATCH',
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ points: points }),
      });
      const err = await anthropicRes.json().catch(() => ({}));
      return res.status(anthropicRes.status).json({ error: err?.error?.message || 'AI service error.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send updated points to client
    res.write(`data: {"type":"points","points":${points - COST}}\n\n`);

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
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
      method: 'PATCH',
      headers: {
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ points: points }),
    });
    return res.status(500).json({ error: err.message || 'Unexpected error.' });
  }
}
