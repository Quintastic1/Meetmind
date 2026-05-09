// api/process-meeting.js
// Vercel Serverless Function — Full AI Pipeline
// Audio → Whisper → Claude summary/actions/score/email → Supabase

import { createClient }  from '@supabase/supabase-js';
import ffmpegInstaller   from '@ffmpeg-installer/ffmpeg';
import ffmpeg            from 'fluent-ffmpeg';
import { tmpdir }        from 'os';
import { writeFile, readFile, unlink } from 'fs/promises';
import { join }          from 'path';
import { randomUUID }    from 'crypto';

// Set ffmpeg path for Vercel
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

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
    const fileName    = audioUrl.split('/').pop() || 'recording.m4a';

    // ── STEP 3: Transcribe with OpenAI Whisper ──────────────────────
    // Check file size — Whisper limit is 25MB
    // If over limit → auto-compress with FFmpeg (customer never knows)
    const fileSizeMB = audioBuffer.length / (1024 * 1024);
    console.log(`File size: ${fileSizeMB.toFixed(1)}MB`);

    let whisperBuffer  = audioBuffer;
    let whisperFileName = fileName;

    if (fileSizeMB > 24) {
      console.log(`File too large (${fileSizeMB.toFixed(1)}MB) — auto-compressing with FFmpeg...`);

      try {
        // Write original file to /tmp
        const tmpId      = randomUUID();
        const inputPath  = join(tmpdir(), `cf-input-${tmpId}.${ext || 'm4a'}`);
        const outputPath = join(tmpdir(), `cf-output-${tmpId}.mp3`);

        await writeFile(inputPath, audioBuffer);

        // Compress to MP3 at 32kbps (voice quality, tiny file size)
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .audioCodec('libmp3lame')
            .audioBitrate('32k')
            .audioChannels(1)        // mono — sufficient for voice
            .audioFrequency(16000)   // 16kHz — Whisper works great at this
            .format('mp3')
            .on('end', resolve)
            .on('error', reject)
            .save(outputPath);
        });

        // Read compressed file
        whisperBuffer   = await readFile(outputPath);
        whisperFileName = `compressed-${tmpId}.mp3`;

        const newSizeMB = whisperBuffer.length / (1024 * 1024);
        console.log(`Compressed: ${fileSizeMB.toFixed(1)}MB → ${newSizeMB.toFixed(1)}MB`);

        // Clean up temp files
        await unlink(inputPath).catch(() => {});
        await unlink(outputPath).catch(() => {});

        if (newSizeMB > 24) {
          throw new Error(`File still too large after compression: ${newSizeMB.toFixed(1)}MB`);
        }
      } catch (compressErr) {
        console.error('Compression failed:', compressErr);
        await sb.from('meetings').update({
          status: 'failed',
          summary: `Your recording (${fileSizeMB.toFixed(0)}MB) is too large to process and compression failed. Please convert to MP3 using cloudconvert.com and try again. A 49-minute call as MP3 is typically under 10MB.`,
        }).eq('id', meetingId);
        return res.status(200).json({ error: 'Compression failed', details: compressErr.message });
      }
    }

    // ── STEP 3: Transcribe with OpenAI Whisper ─────────────────────────
    // Detect content type from file extension
    const ext = fileName.split('.').pop().toLowerCase();
    const contentTypeMap = {
      'mp3':  'audio/mpeg',
      'mp4':  'audio/mp4',
      'm4a':  'audio/mp4',  // iPhone Voice Memo format
      'wav':  'audio/wav',
      'wave': 'audio/wav',
      'webm': 'audio/webm',
      'ogg':  'audio/ogg',
      'flac': 'audio/flac',
      'aac':  'audio/aac',
      'caf':  'audio/mp4',  // iPhone Core Audio Format
      'mov':  'video/quicktime',
    };
    const contentType = contentTypeMap[ext] || 'audio/mp4';

    // Use native FormData with Blob — works correctly in Node 18+
    // Use compressed buffer if file was auto-compressed
    const whisperType = whisperFileName.endsWith('.mp3') ? 'audio/mpeg' : contentType;
    const audioBlob  = new Blob([whisperBuffer], { type: whisperType });
    const formData   = new FormData();
    formData.append('file', audioBlob, whisperFileName);
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('temperature', '0');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        // Note: Do NOT set Content-Type header manually
        // fetch sets it automatically with the correct boundary for multipart
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
  "title": "MUST follow this exact format: [Prospect First Name Last Name] · [Main Topic Discussed in 3-5 words]. Examples: 'Ana Mata · Discussed bilingual sales tools', 'Carlos García · Explored insurance pricing options', 'John Smith · Follow-up on Q4 proposal'. Use the prospect's REAL name from the transcript — not the company name.",
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

    // Sanitize email - decode any URL encoding from Claude response
    const emailSubject = (emailDraft.subject || '').replace(/%20/g, ' ').replace(/%0A/g, ' ');
    let emailBody = (emailDraft.body || '');
    try { emailBody = decodeURIComponent(emailBody.replace(/\+/g, ' ')); } catch(e) {}
    const followUpEmail = `Subject: ${emailSubject}\n\n${emailBody}`;

    // ── STEP 6: The Forged — Generate 4 AI coach insights ─────────────
    const forgedPrompts = {
      maya: {
        name: 'Maya the Spark',
        role: 'Pitch Coach',
        prompt: `You are Maya the Spark, a bilingual pitch coach analyzing a ${isSpanish ? 'Spanish' : 'English'} sales call.

TRANSCRIPT:
${transcript}

CALL SUMMARY: ${analysis.summary}

Analyze the PITCH quality of this call. Focus on: opening strength, value proposition clarity, storytelling, enthusiasm, pacing, and how well the rep captured attention.

Respond ONLY with valid JSON, no markdown:
{
  "headline": "One punchy sentence summarizing pitch performance (e.g. 'Strong opener, weak value prop')",
  "score": 74,
  "what_worked": ["Specific thing that worked", "Another thing that worked"],
  "what_to_improve": ["Specific thing to improve with exact suggestion"],
  "best_moment": "Timestamp or description of their best pitch moment",
  "next_call_tip": "One specific actionable tip for their next call"
}`
      },
      sam: {
        name: 'Sam the Anvil',
        role: 'Follow-up Coach',
        prompt: `You are Sam the Anvil, a bilingual follow-up specialist analyzing a ${isSpanish ? 'Spanish' : 'English'} sales call.

TRANSCRIPT:
${transcript}

FOLLOW-UP EMAIL DRAFTED: ${followUpEmail}

Analyze the FOLLOW-UP OPPORTUNITIES from this call. Focus on: timing recommendations, relationship warmth, what to emphasize, what to avoid, and how to keep momentum.

Respond ONLY with valid JSON, no markdown:
{
  "headline": "One sentence about the follow-up situation (e.g. 'Hot lead — follow up within 2 hours')",
  "urgency": "high", "medium", or "low",
  "send_within": "e.g. '2 hours' or '24 hours' or '3 days'",
  "key_points_to_reinforce": ["Point from the call to reinforce", "Another point"],
  "what_to_avoid": ["Thing to avoid in follow-up"],
  "subject_line_tip": "Specific advice on the subject line",
  "relationship_temperature": "warm", "cool", or "neutral"
}`
      },
      finn: {
        name: 'Finn the Tongs',
        role: 'Deal Analyst',
        prompt: `You are Finn the Tongs, a bilingual deal analyst reviewing a ${isSpanish ? 'Spanish' : 'English'} sales call.

TRANSCRIPT:
${transcript}

DEAL SCORE: ${analysis.deal_score}/100

Provide deep deal analysis. Focus on: buying signals detected, risk factors, decision maker access, budget signals, competition mentioned, deal timeline, and probability.

Respond ONLY with valid JSON, no markdown:
{
  "headline": "One sentence deal status (e.g. 'Strong opportunity — decision maker engaged, budget confirmed')",
  "win_probability": 65,
  "buying_signals": ["Specific buying signal detected", "Another signal"],
  "risk_factors": ["Specific risk to watch", "Another risk"],
  "next_milestone": "What needs to happen to advance this deal",
  "decision_maker_access": "direct", "indirect", or "unknown",
  "budget_status": "confirmed", "likely", "uncertain", or "objected",
  "competition_mentioned": true or false,
  "recommended_action": "Specific next action to advance the deal"
}`
      },
      aria: {
        name: 'Aria the Hammer',
        role: 'Objection Coach',
        prompt: `You are Aria the Hammer, a bilingual objection handling specialist analyzing a ${isSpanish ? 'Spanish' : 'English'} sales call.

TRANSCRIPT:
${transcript}

KEY OBJECTIONS FROM ANALYSIS: ${analysis.key_objections?.join(', ') || 'none noted'}

List TOP 3 objections only. Every field must be under 15 words.

Respond ONLY with valid JSON, no markdown, no extra text:
{
  "headline": "Short summary under 10 words",
  "objections_count": 2,
  "objections": [
    {
      "objection": "What prospect said - under 8 words",
      "how_handled": "good",
      "what_was_said": "Rep response under 10 words",
      "better_response": "Better response under 15 words"
    }
  ],
  "overall_handling": "strong",
  "pattern_to_watch": "Pattern under 10 words",
  "coaching_tip": "One tip under 15 words"
}`
      }
    };

    // Run all 4 Forged coaches in parallel for speed
    const forgedResults = await Promise.allSettled(
      Object.entries(forgedPrompts).map(async ([key, coach]) => {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1200,
            messages: [{ role: 'user', content: coach.prompt }],
          }),
        });
        const data = await res.json();
        if (!data.content?.[0]?.text) {
          console.error(`${key} coach returned no content:`, JSON.stringify(data));
          throw new Error(`${key} coach: no content in response`);
        }
        const raw = data.content[0].text.trim()
          .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        let insight;
        try {
          insight = JSON.parse(raw);
        } catch(parseErr) {
          console.error(`${key} JSON parse failed. Raw:`, raw.substring(0, 200));
          // Try to salvage partial JSON for Aria
          if (key === 'aria') {
            insight = {
              headline: 'Objection analysis available — see summary',
              objections: [],
              overall_handling: 'average',
              coaching_tip: 'Review the call summary for objection details',
              objections_count: 0,
            };
          } else {
            throw parseErr;
          }
        }
        return { key, coach_name: coach.name, role: coach.role, insight };
      })
    );

    // Save Forged insights to Supabase (non-fatal if fails)
    const forgedInsights = forgedResults
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    if (forgedInsights.length > 0) {
      try {
        await sb.from('forged_insights').insert(
          forgedInsights.map(f => ({
            meeting_id:  meetingId,
            user_id:     userId,
            coach_name:  f.coach_name,
            insight:     JSON.stringify(f.insight),
          }))
        );
      } catch (forgedSaveErr) {
        console.error('Forged insights save failed (non-fatal):', forgedSaveErr);
      }
    }

    // ── STEP 7: Save everything to Supabase ────────────────────────────
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

    // ── STEP 8: Send "meeting ready" email via Resend ──────────────────
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

    // ── STEP 9: Return success ─────────────────────────────────────────
    return res.status(200).json({
      success:        true,
      meetingId,
      title:          analysis.title,
      summary:        analysis.summary,
      action_items:   analysis.action_items,
      deal_score:     analysis.deal_score,
      follow_up_email: followUpEmail,
      language,
      forged_insights: forgedInsights,
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
