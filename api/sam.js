// api/sam.js
// Sam the Anvil — Callforge Sales Outreach Agent
// Analyzes prospect data, detects language, generates bilingual outreach sequences

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Anthropic API key not configured' });
  }

  const { prospect } = req.body;

  if (!prospect || !prospect.name) {
    return res.status(400).json({ error: 'Missing prospect data' });
  }

  // ── LANGUAGE DETECTION PROMPT ──────────────────────────────────────────
  const langPrompt = `You are Sam, an expert bilingual sales intelligence agent for Callforge — a bilingual AI meeting intelligence tool for sales teams.

Analyze this prospect and determine whether to reach out in English or Spanish.

PROSPECT DATA:
Name: ${prospect.name}
Title: ${prospect.title || 'Unknown'}
Company: ${prospect.company || 'Unknown'}
Location: ${prospect.location || 'Unknown'}
Industry: ${prospect.industry || 'Unknown'}
LinkedIn Bio: ${prospect.bio || 'Not provided'}
Notes: ${prospect.notes || 'None'}

LANGUAGE DETECTION RULES:
- Hispanic surnames (García, Martínez, López, Rodríguez, González, etc.) = Spanish lean
- Latin American locations (Miami, Houston, LA, NYC Hispanic areas, Mexico, Colombia, etc.) = Spanish lean
- Spanish words in bio or title = Spanish confirmed
- LATAM company names = Spanish confirmed
- Anglo names + non-LATAM location = English
- Mixed signals = English with Spanish PS bridge line
- When in doubt = English (safer, can always follow up in Spanish)

Respond ONLY with valid JSON, no markdown:
{
  "language": "en" or "es",
  "confidence": "high", "medium", or "low",
  "reasoning": "One sentence explaining the decision",
  "prospect_tier": "owner", "manager", or "rep",
  "prospect_pain": "One sentence describing their likely biggest pain point",
  "personalization_hook": "One specific detail about them to personalize messages"
}`;

  let langAnalysis;
  try {
    const langRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // Fast + cheap for classification
        max_tokens: 400,
        messages: [{ role: 'user', content: langPrompt }],
      }),
    });

    const langData = await langRes.json();
    const raw = langData.content[0].text.trim()
      .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    langAnalysis = JSON.parse(raw);
  } catch (e) {
    // Fallback if language detection fails
    langAnalysis = {
      language: 'en',
      confidence: 'low',
      reasoning: 'Could not analyze — defaulting to English',
      prospect_tier: 'manager',
      prospect_pain: 'Spending too much time on post-call admin',
      personalization_hook: prospect.company || prospect.name,
    };
  }

  const lang   = langAnalysis.language;
  const isES   = lang === 'es';
  const tier   = langAnalysis.prospect_tier;
  const hook   = langAnalysis.personalization_hook;
  const pain   = langAnalysis.prospect_pain;

  // ── OUTREACH GENERATION PROMPT ─────────────────────────────────────────
  // ── DEMO INVITE MODE ──────────────────────────────────────────────────
  const isDemoMode = prospect.outreach_type === 'demo';

  if (isDemoMode) {
    const demoPrompt = `You are Sam the Anvil — Callforge's bilingual sales agent. Generate a "Live Demo Invite" outreach sequence for a business owner.

ABOUT CALLFORGE:
Callforge is a bilingual AI meeting intelligence tool for sales teams. It records calls, generates summaries, extracts action items, scores deals, and drafts follow-up emails — in English or Spanish automatically.

THE CONCEPT:
At Callforge we flip the traditional demo on its head. Instead of us demoing TO them, we invite the business owner to sell US their product. We record the call, run it through Callforge in real time, and show them exactly what their pitch looks like from the other side. They see the AI coaching feedback on their own voice, their own call.

THE CALLFORGE VOICE FOR THIS:
"At Callforge we turn the demo on its head a little bit — you are way better at sales than we are. We want you to sell your product to us, and we'll let the Forge work for you in real time and give you feedback."

Keep that spirit — genuine, humble, a little playful, not salesy at all.

PROSPECT:
Name: ${prospect.name}
Title: ${prospect.title || 'Business Owner'}
Company: ${prospect.company || 'their company'}
Location: ${prospect.location || 'their area'}
Industry: ${prospect.industry || 'their industry'}
Language: ${isES ? 'SPANISH — write everything in Spanish' : 'ENGLISH — write everything in English'}

TONE RULES:
- Sound like a real founder, not a salesperson
- Genuine curiosity about their business
- The ask should feel like a favor TO THEM not to us
- Playful and confident — never pushy
- Short sentences. Conversational.
- Never say "I hope this message finds you well"
- LinkedIn DMs: max 3 sentences
- Cold emails: max 150 words

Generate ALL outreach in ${isES ? 'SPANISH' : 'ENGLISH'}. Respond ONLY with valid JSON, no markdown:
{
  "linkedin_dm": "2-3 sentence LinkedIn DM inviting them to pitch us",
  "cold_email": {
    "subject": "Subject line that sparks curiosity",
    "body": "Full email under 150 words with the flip-the-demo concept"
  },
  "calendar_invite_description": "The description text for the actual calendar invite they receive — explains the concept warmly, mentions Callforge will run in real time, sets expectations for what they will see",
  "post_demo_followup": {
    "subject": "Follow-up subject after the demo call",
    "body": "Email sent right after the demo — references their specific call, highlights what the Forge found, natural close to start a trial"
  },
  "follow_up_1": {
    "subject": "Follow-up if they haven't responded to the initial outreach",
    "body": "Short bump — keeps the playful tone",
    "send_after_days": 3
  },
  "objection_responses": {
    "why_would_i_pitch_you": "Response to 'why would I pitch you?' — playful and honest",
    "not_enough_time": "Response to 'I don't have time for this'",
    "what_is_callforge": "Quick explanation of Callforge when they ask what it is before agreeing",
    "whats_in_it_for_me": "Response to 'what do I get out of this?' — honest value prop for them"
  }
}`;

    try {
      const demoRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          messages: [{ role: 'user', content: demoPrompt }],
        }),
      });

      if (!demoRes.ok) {
        const err = await demoRes.json();
        throw new Error(`Demo outreach failed: ${JSON.stringify(err)}`);
      }

      const demoData  = await demoRes.json();
      const demoRaw   = demoData.content[0].text.trim()
        .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const demoOutput = JSON.parse(demoRaw);

      return res.status(200).json({
        success:       true,
        mode:          'demo',
        language:      langAnalysis.language,
        confidence:    langAnalysis.confidence,
        reasoning:     langAnalysis.reasoning,
        prospect_tier: langAnalysis.prospect_tier,
        prospect_pain: langAnalysis.prospect_pain,
        hook:          langAnalysis.personalization_hook,
        outreach:      demoOutput,
        prospect,
      });

    } catch (error) {
      console.error('Demo mode error:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  const tierMessages = {
    owner: isES
      ? 'enfocado en ROI del equipo, reemplazar o aumentar al gerente de ventas, visibilidad total de llamadas'
      : 'focused on team ROI, replacing or augmenting the sales manager, full call visibility',
    manager: isES
      ? 'enfocado en coaching del equipo, visibilidad de llamadas, ahorrar tiempo en reportes'
      : 'focused on team coaching, call visibility, saving time on reporting',
    rep: isES
      ? 'enfocado en ahorrar tiempo post-llamada, nunca perder seguimientos, cerrar más tratos'
      : 'focused on saving post-call time, never missing follow-ups, closing more deals',
  };

  const outreachPrompt = `You are Sam the Anvil — Callforge's expert bilingual sales outreach agent. You write sales messages that feel human, warm, and never pushy.

ABOUT CALLFORGE:
- Bilingual AI meeting intelligence for sales teams (English + Spanish)
- Records sales calls, generates summaries, extracts action items, scores deals, drafts follow-up emails
- Only tool built specifically for bilingual/Latin American sales teams
- Pricing: Starter $49/mo, Pro $99/mo, Team $299/mo
- No competitor (Otter, Fathom, Fireflies, Gong) offers true bilingual support
- Live at callforge.to

PROSPECT:
Name: ${prospect.name}
Title: ${prospect.title || 'Sales professional'}
Company: ${prospect.company || 'their company'}
Location: ${prospect.location || 'their area'}
Industry: ${prospect.industry || 'their industry'}
Language: ${isES ? 'SPANISH — write everything in Spanish' : 'ENGLISH — write everything in English'}
Tier: ${tier} — ${tierMessages[tier] || tierMessages.rep}
Pain point: ${pain}
Personalization hook: ${hook}

TONE RULES:
- Sound like a real person, not a robot
- Short sentences. Conversational.
- Never say "I hope this message finds you well"
- Never use "synergy", "leverage", "circle back", "reach out"
- Always lead with their pain, not our product
- One clear CTA per message — never more
- LinkedIn DMs: max 3 sentences
- Cold emails: max 150 words body
- Follow-ups: shorter than original

Generate ALL outreach in ${isES ? 'SPANISH' : 'ENGLISH'}. Respond ONLY with valid JSON, no markdown:

{
  "linkedin_dm": "Short 2-3 sentence LinkedIn DM",
  "cold_email": {
    "subject": "Email subject line",
    "body": "Full email body under 150 words"
  },
  "follow_up_1": {
    "subject": "Follow up subject",
    "body": "Short follow up email — sent 3 days later if no reply",
    "send_after_days": 3
  },
  "follow_up_2": {
    "subject": "Final follow up subject",
    "body": "Final short email — the breakup email sent 7 days later",
    "send_after_days": 7
  },
  "instagram_dm": "Very short casual IG DM — 1-2 sentences max",
  "reddit_comment": "Helpful comment for a sales subreddit that naturally mentions Callforge — sounds organic not spammy",
  "objection_responses": {
    "too_expensive": "Response to 'too expensive' objection in ${isES ? 'Spanish' : 'English'}",
    "already_use_gong": "Response to 'we already use Gong/Otter' in ${isES ? 'Spanish' : 'English'}",
    "not_interested": "Response to 'not interested' that re-engages in ${isES ? 'Spanish' : 'English'}",
    "no_budget": "Response to 'no budget right now' in ${isES ? 'Spanish' : 'English'}"
  }
}`;

  try {
    const outreachRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: outreachPrompt }],
      }),
    });

    if (!outreachRes.ok) {
      const err = await outreachRes.json();
      throw new Error(`Claude outreach failed: ${JSON.stringify(err)}`);
    }

    const outreachData = await outreachRes.json();
    const rawOutreach  = outreachData.content[0].text.trim()
      .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const outreach = JSON.parse(rawOutreach);

    return res.status(200).json({
      success:      true,
      language:     langAnalysis.language,
      confidence:   langAnalysis.confidence,
      reasoning:    langAnalysis.reasoning,
      prospect_tier: langAnalysis.prospect_tier,
      prospect_pain: langAnalysis.prospect_pain,
      hook:         langAnalysis.personalization_hook,
      outreach,
      prospect,
    });

  } catch (error) {
    console.error('Sam error:', error);
    return res.status(500).json({ error: error.message });
  }
}
