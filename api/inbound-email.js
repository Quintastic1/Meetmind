// api/inbound-email.js
// Handles recordings forwarded to process+[username]@callforge.to
// Resend inbound webhook → extract audio attachment → trigger AI pipeline

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Resend sends inbound email as multipart form data
    const {
      to,
      from,
      subject,
      attachments,
    } = req.body;

    console.log('Inbound email from:', from, 'to:', to);

    if (!to || !from) {
      return res.status(400).json({ error: 'Missing to/from' });
    }

    // ── STEP 1: Identify the user ──────────────────────────────────────────
    // Strategy 1: Check the + tag in the To address
    // e.g. process+qstuard01@callforge.to → look up user by email prefix
    let userId   = null;
    let userEmail = null;
    let userName  = null;

    // Parse the + tag from To address
    const toMatch = to.match(/process\+([^@]+)@callforge\.to/i);
    if (toMatch) {
      const emailPrefix = toMatch[1].toLowerCase();
      // Look up user whose email starts with this prefix
      const { data: profiles } = await sb
        .from('profiles')
        .select('id, email, full_name')
        .ilike('email', `${emailPrefix}%`)
        .limit(1);

      if (profiles?.length > 0) {
        userId    = profiles[0].id;
        userEmail = profiles[0].email;
        userName  = profiles[0].full_name;
      }
    }

    // Strategy 2: Match sender email to a Callforge account
    if (!userId && from) {
      const senderEmail = from.match(/<(.+)>/)?.[1] || from;
      const { data: profiles } = await sb
        .from('profiles')
        .select('id, email, full_name')
        .eq('email', senderEmail.toLowerCase())
        .limit(1);

      if (profiles?.length > 0) {
        userId    = profiles[0].id;
        userEmail = profiles[0].email;
        userName  = profiles[0].full_name;
      }
    }

    if (!userId) {
      console.error('Could not identify user from email:', { to, from });
      // Send a helpful reply
      return res.status(200).json({
        error: 'User not found',
        message: 'No Callforge account found for this email address'
      });
    }

    // ── STEP 2: Find the audio attachment ─────────────────────────────────
    if (!attachments || !Array.isArray(attachments) || attachments.length === 0) {
      console.error('No attachments found in email');
      return res.status(200).json({ error: 'No audio attachment found' });
    }

    // Find first audio attachment
    const audioAttachment = attachments.find(att => {
      const type = (att.content_type || att.type || '').toLowerCase();
      const name = (att.filename || att.name || '').toLowerCase();
      return (
        type.includes('audio') ||
        type.includes('video') ||
        type.includes('octet-stream') ||
        name.match(/\.(mp3|mp4|m4a|wav|webm|ogg|aac|flac|caf|mov)$/)
      );
    });

    if (!audioAttachment) {
      console.error('No audio attachment found among:', attachments.map(a => a.filename));
      return res.status(200).json({ error: 'No audio attachment found' });
    }

    const fileName    = audioAttachment.filename || audioAttachment.name || 'email-recording.m4a';
    const contentType = audioAttachment.content_type || audioAttachment.type || 'audio/m4a';

    console.log('Processing attachment:', fileName, contentType);

    // ── STEP 3: Decode the attachment ─────────────────────────────────────
    // Resend sends attachments as base64
    let audioBuffer;
    if (audioAttachment.content) {
      audioBuffer = Buffer.from(audioAttachment.content, 'base64');
    } else if (audioAttachment.data) {
      audioBuffer = Buffer.from(audioAttachment.data, 'base64');
    } else {
      return res.status(200).json({ error: 'Could not read attachment data' });
    }

    console.log('Audio buffer size:', audioBuffer.length, 'bytes');

    // ── STEP 4: Upload to Supabase Storage ────────────────────────────────
    const safeName  = fileName.replace(/[^a-zA-Z0-9._-]/g, '-');
    const storagePath = `${userId}/${Date.now()}-email-${safeName}`;

    const { error: uploadError } = await sb.storage
      .from('recordings')
      .upload(storagePath, audioBuffer, {
        contentType,
        upsert: false,
      });

    if (uploadError) {
      console.error('Storage upload failed:', uploadError);
      throw new Error(`Storage upload failed: ${uploadError.message}`);
    }

    // ── STEP 5: Create meeting record ─────────────────────────────────────
    const meetingTitle = subject
      ? subject.replace(/^(re:|fwd?:|fw:)\s*/i, '').trim()
      : `Email Recording — ${new Date().toLocaleDateString()}`;

    const { data: meeting, error: meetingError } = await sb
      .from('meetings')
      .insert({
        user_id:   userId,
        title:     meetingTitle,
        status:    'pending',
        audio_url: storagePath,
      })
      .select()
      .single();

    if (meetingError) throw new Error(`Meeting insert failed: ${meetingError.message}`);

    // ── STEP 6: Trigger AI pipeline ───────────────────────────────────────
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'https://callforge.to';

    fetch(`${baseUrl}/api/process-meeting`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meetingId: meeting.id,
        audioUrl:  storagePath,
        userId,
        userEmail,
        userName: userName || 'there',
      }),
    }).catch(err => console.error('Pipeline trigger failed (non-fatal):', err));

    console.log('Email upload success! Meeting ID:', meeting.id);

    return res.status(200).json({
      success:   true,
      meetingId: meeting.id,
      message:   'Recording received and processing started',
    });

  } catch (error) {
    console.error('Inbound email error:', error);
    return res.status(500).json({ error: error.message });
  }
}
