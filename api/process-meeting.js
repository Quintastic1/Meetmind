// api/process-meeting.js
// Vercel Serverless Function — Full AI Pipeline
// Audio → Whisper → Claude summary/actions/score/email → Supabase

import { createClient } from '@supabase/supabase-js';
import FormData from 'form-data';

// ── CONFIG ─────────────────────────────────────────────────────────────────
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OPENAI_API_KEY       = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const RESEND_API_KEY       = process.env.RESEND_API_KEY;

// Vercel free plan has 10s limit, Pro has 60s
// For audio processing we need more time — using streaming response pattern
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { meetingId, audioUrl, userEmail, userName, userId } = req.body;

  if (!meetingId || !audioUrl || !userId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // ── STEP 1: Update status to processing ────────────────────────────
    await sb.from('meetings').update({ status: 'processing' }).eq('id', meetingId);

    // ── STEP 2: Download audio from Supabase Storage ───────────────────
    const { data: audioData, error: downloadError } = await sb.storage
      .from('recordings')
      .download(audioUrl);

    if (downloadError) throw new Error(`Download failed: ${downloadError.message}`);

    const audioBuffer = Buffer.from(await audioData.arrayBuffer());
    const fileName    = audioUrl.split('/').pop() || 'recording.mp3';

    // ── STEP 3: Transcribe with OpenAI Whisper ─────────────────────────
    const formData = new FormData();
    formData.append('file', audioBuffer, { filename: fileName, contentType: 'audio/mpeg' });
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json'); // gives us language detection
    formData.append('temperature', '0');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        ...formData.getHeaders(),
      },
      body: formData,
    });

    if (!whisperRes.ok) {
      const err = await whisperRes.json();
      throw new Error(`Whisper failed: ${JSON.stringify(err)}`);
    }

    const whisperData = await whisperRes.json();
    const transcript  = whisperData.text;
    const language    = whisperData.language === 'spanish' ? 'es' : 'en';
    const isSpanish   = language === 'es';

    // ── STEP 4: Claude — Generate summary + action items + deal score ───
    const analysisPrompt = `You are an expert sales call analyst. Analyze this ${isSpanish ? 'Spanish' : 'English'} sales call transcript and respond ONLY with a valid JSON object — no markdown, no backticks, no explanation.

TRANSCRIPT:
${transcript}

Respond with exactly this JSON structure:
{
  "title": "Brief descriptive title for this call (e.g. 'Acme Corp Discovery Call' or 'Mendoza & Asociados — Q4 Renewal')",
  "summary": "3-4 sentence summary of what happened on the call, key points discussed, and current status of the deal.",
  "action_items": [
    "Specific action item 1 with owner and deadline if mentioned",
    "Specific action item 2",
    "Specific action item 3"
  ],
  "deal_score": 75,
  "deal_score_reasoning": "One sentence explaining the score",
  "sentiment": "positive",
  "key_objections": ["objection 1", "objection 2"],
  "next_steps": "What should happen next to advance this deal"
}

Scoring guide for deal_score (0-100):
- 80-100: Strong buying signals, clear next steps, budget confirmed
- 60-79: Interested but some friction, follow-up required
- 40-59: Lukewarm, significant obstacles
- 0-39: Poor fit, stalling, or strong objections

${isSpanish ? 'Respond with the summary, action_items, deal_score_reasoning, key_objections, and next_steps IN SPANISH since this was a Spanish call. The JSON keys stay in English.' : ''}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: analysisPrompt }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json();
      throw new Error(`Claude analysis failed: ${JSON.stringify(err)}`);
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content[0].text.trim();

    // Parse JSON — strip any accidental markdown fences
    const cleanJson = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const analysis  = JSON.parse(cleanJson);

    // ── STEP 5: Claude — Generate follow-up email ──────────────────────
    const emailPrompt = `You are an expert sales email writer. Based on this sales call analysis, write a professional, personalized follow-up email.

Call title: ${analysis.title}
Summary: ${analysis.summary}
Action items: ${analysis.action_items.join(', ')}
Next steps: ${analysis.next_steps}
Deal score: ${analysis.deal_score}/100
Key objections: ${analysis.key_objections?.join(', ') || 'none'}

Write a follow-up email that:
- Has a compelling subject line
- Opens warmly and references something specific from the call
- Recaps the key points and confirms next steps
- Addresses any objections gently
- Has a clear call to action
- Sounds human and natural, NOT robotic
- Is concise (under 200 words for the body)
${isSpanish ? '- Is written entirely in Spanish since this was a Spanish-language call' : ''}

Respond ONLY with valid JSON — no markdown, no backticks:
{
  "subject": "Email subject line here",
  "body": "Full email body here with \\n for line breaks"
}`;

    const emailRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        messages: [{ role: 'user', content: emailPrompt }],
      }),
    });

    if (!emailRes.ok) {
      const err = await emailRes.json();
      throw new Error(`Claude email failed: ${JSON.stringify(err)}`);
    }

    const emailData  = await emailRes.json();
    const emailRaw   = emailData.content[0].text.trim();
    const emailClean = emailRaw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const emailDraft = JSON.parse(emailClean);

    const followUpEmail = `Subject: ${emailDraft.subject}\n\n${emailDraft.body}`;

    // ── STEP 6: Save everything to Supabase ────────────────────────────
    const { error: updateError } = await sb.from('meetings').update({
      title:            analysis.title,
      transcript:       transcript,
      summary:          analysis.summary,
      action_items:     analysis.action_items,
      deal_score:       analysis.deal_score,
      follow_up_email:  followUpEmail,
      language:         language,
      status:           'done',
    }).eq('id', meetingId);

    if (updateError) throw new Error(`Supabase update failed: ${updateError.message}`);

    // ── STEP 7: Send "meeting ready" email via Resend ──────────────────
    if (userEmail && RESEND_API_KEY) {
      try {
        await fetch(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://callforge.to'}/api/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'meeting_ready',
            to: userEmail,
            name: userName || 'there',
            data: {
              title:        analysis.title,
              summary:      analysis.summary,
              action_items: analysis.action_items,
              deal_score:   analysis.deal_score,
              language:     language,
            },
          }),
        });
      } catch (emailErr) {
        // Non-fatal — log but don't fail the whole pipeline
        console.error('Meeting ready email failed (non-fatal):', emailErr);
      }
    }

    // ── STEP 8: Return success ─────────────────────────────────────────
    return res.status(200).json({
      success:        true,
      meetingId,
      title:          analysis.title,
      summary:        analysis.summary,
      action_items:   analysis.action_items,
      deal_score:     analysis.deal_score,
      follow_up_email: followUpEmail,
      language,
    });

  } catch (error) {
    console.error('Pipeline error:', error);

    // Mark meeting as failed in database
    try {
      const sb2 = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      await sb2.from('meetings').update({ status: 'failed' }).eq('id', meetingId);
    } catch(e) { /* ignore */ }

    return res.status(500).json({ error: error.message });
  }
}
