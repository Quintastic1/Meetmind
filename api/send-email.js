// api/send-email.js
// Vercel Serverless Function — handles all Resend email sending
// Callforge email system: waitlist confirmation + welcome + meeting ready

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    return res.status(500).json({ error: 'Resend API key not configured' });
  }

  const { type, to, name, data } = req.body;

  if (!type || !to) {
    return res.status(400).json({ error: 'Missing required fields: type, to' });
  }

  let subject = '';
  let html = '';

  // ── EMAIL TEMPLATES ────────────────────────────────────────────────────

  if (type === 'waitlist_confirmation') {
    subject = "⚒ You're on the Callforge waitlist!";
    html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f4f1ea;font-family:'Cabinet Grotesk',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:40px 20px">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#0a0e1a;border-radius:16px;overflow:hidden;max-width:560px">

          <!-- Header -->
          <tr>
            <td style="padding:32px 40px 24px;border-bottom:1px solid rgba(255,255,255,0.07)">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:linear-gradient(135deg,#ff6b1a,#ffd166);width:28px;height:28px;border-radius:7px;text-align:center;vertical-align:middle">
                    <span style="font-size:14px;color:#fff">⚒</span>
                  </td>
                  <td style="padding-left:8px">
                    <span style="font-family:Arial,sans-serif;font-size:20px;font-weight:700;color:#f4f1ea">Call</span><span style="font-family:Arial,sans-serif;font-size:20px;font-weight:700;color:#ff6b1a">forge</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px">
              <p style="font-size:28px;margin:0 0 8px;color:#ffd166;font-weight:700">⚒ You're on the list!</p>
              <p style="font-size:16px;margin:0 0 24px;color:#f4f1ea;font-weight:600">Hey ${name || 'there'}, welcome to Callforge.</p>
              <p style="font-size:14px;margin:0 0 16px;color:rgba(244,241,234,0.7);line-height:1.6">
                We're hammering Callforge into shape and you'll be one of the first to forge your sales calls into closed deals.
              </p>
              <p style="font-size:14px;margin:0 0 24px;color:rgba(244,241,234,0.7);line-height:1.6">
                As an early waitlist member, you'll get:
              </p>

              <!-- Perks -->
              <table cellpadding="0" cellspacing="0" style="background:rgba(255,107,26,0.08);border:1px solid rgba(255,107,26,0.2);border-radius:12px;width:100%;margin-bottom:28px">
                <tr><td style="padding:20px 24px">
                  <p style="margin:0 0 10px;color:#f4f1ea;font-size:13px">✓ &nbsp;<strong>25% off your first 6 months</strong></p>
                  <p style="margin:0 0 10px;color:#f4f1ea;font-size:13px">✓ &nbsp;<strong>Early access</strong> before public launch</p>
                  <p style="margin:0;color:#f4f1ea;font-size:13px">✓ &nbsp;<strong>Direct access</strong> to the founders</p>
                </td></tr>
              </table>

              <!-- CTA -->
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#ff6b1a;border-radius:8px">
                    <a href="https://callforge.to" style="display:inline-block;padding:14px 28px;color:#fff;text-decoration:none;font-size:14px;font-weight:700">Visit callforge.to →</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;border-top:1px solid rgba(255,255,255,0.07)">
              <p style="margin:0;font-size:12px;color:rgba(244,241,234,0.3);line-height:1.6">
                — Ana & Quin · Callforge founders<br>
                Forged with care in Florida 🇺🇸<br>
                <a href="https://callforge.to" style="color:#ff6b1a;text-decoration:none">callforge.to</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  else if (type === 'welcome') {
    subject = "⚒ Welcome to Callforge — let's forge your first call";
    html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f4f1ea;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:40px 20px">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#0a0e1a;border-radius:16px;overflow:hidden;max-width:560px">

          <tr>
            <td style="padding:32px 40px 24px;border-bottom:1px solid rgba(255,255,255,0.07)">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:linear-gradient(135deg,#ff6b1a,#ffd166);width:28px;height:28px;border-radius:7px;text-align:center;vertical-align:middle">
                    <span style="font-size:14px;color:#fff">⚒</span>
                  </td>
                  <td style="padding-left:8px">
                    <span style="font-size:20px;font-weight:700;color:#f4f1ea">Call</span><span style="font-size:20px;font-weight:700;color:#ff6b1a">forge</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:40px 40px 32px">
              <p style="font-size:26px;margin:0 0 8px;color:#ffd166;font-weight:700">Welcome to Callforge, ${name || 'founder'}! 🔥</p>
              <p style="font-size:14px;margin:0 0 24px;color:rgba(244,241,234,0.7);line-height:1.6">
                Your account is confirmed and you're ready to start forging. Here's how to get started in 3 steps:
              </p>

              <!-- Steps -->
              <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:28px">
                <tr>
                  <td style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px 20px;margin-bottom:10px">
                    <p style="margin:0 0 4px;color:#ff6b1a;font-size:11px;font-weight:700;letter-spacing:1px">STEP 1</p>
                    <p style="margin:0;color:#f4f1ea;font-size:13px;font-weight:600">Upload your first sales call recording</p>
                    <p style="margin:4px 0 0;color:rgba(244,241,234,0.5);font-size:12px">MP3, MP4, WAV, M4A — up to 500MB</p>
                  </td>
                </tr>
                <tr><td style="height:8px"></td></tr>
                <tr>
                  <td style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px 20px">
                    <p style="margin:0 0 4px;color:#ff6b1a;font-size:11px;font-weight:700;letter-spacing:1px">STEP 2</p>
                    <p style="margin:0;color:#f4f1ea;font-size:13px;font-weight:600">Callforge forges it in under 2 minutes</p>
                    <p style="margin:4px 0 0;color:rgba(244,241,234,0.5);font-size:12px">Summary, action items, deal score, follow-up email</p>
                  </td>
                </tr>
                <tr><td style="height:8px"></td></tr>
                <tr>
                  <td style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px 20px">
                    <p style="margin:0 0 4px;color:#ff6b1a;font-size:11px;font-weight:700;letter-spacing:1px">STEP 3</p>
                    <p style="margin:0;color:#f4f1ea;font-size:13px;font-weight:600">Meet The Forged — your AI coach team</p>
                    <p style="margin:4px 0 0;color:rgba(244,241,234,0.5);font-size:12px">Maya, Sam, Finn and Aria are ready to help you close</p>
                  </td>
                </tr>
              </table>

              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#ff6b1a;border-radius:8px">
                    <a href="https://callforge.to/dashboard.html" style="display:inline-block;padding:14px 28px;color:#fff;text-decoration:none;font-size:14px;font-weight:700">Go to your dashboard →</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 40px;border-top:1px solid rgba(255,255,255,0.07)">
              <p style="margin:0;font-size:12px;color:rgba(244,241,234,0.3);line-height:1.6">
                — Ana & Quin · Callforge founders<br>
                Questions? Reply to this email or reach us at <a href="mailto:hello@callforge.to" style="color:#ff6b1a;text-decoration:none">hello@callforge.to</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  else if (type === 'meeting_ready') {
    const meeting = data || {};
    subject = `⚒ Your call is forged — "${meeting.title || 'Meeting'}" is ready`;
    html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f4f1ea;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:40px 20px">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#0a0e1a;border-radius:16px;overflow:hidden;max-width:560px">

          <tr>
            <td style="padding:32px 40px 24px;border-bottom:1px solid rgba(255,255,255,0.07)">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:linear-gradient(135deg,#ff6b1a,#ffd166);width:28px;height:28px;border-radius:7px;text-align:center;vertical-align:middle">
                    <span style="font-size:14px;color:#fff">⚒</span>
                  </td>
                  <td style="padding-left:8px">
                    <span style="font-size:20px;font-weight:700;color:#f4f1ea">Call</span><span style="font-size:20px;font-weight:700;color:#ff6b1a">forge</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:40px 40px 32px">
              <p style="font-size:26px;margin:0 0 8px;color:#ffd166;font-weight:700">Your call is forged! 🔥</p>
              <p style="font-size:15px;margin:0 0 6px;color:#f4f1ea;font-weight:600">${meeting.title || 'Your meeting'}</p>
              <p style="font-size:12px;margin:0 0 28px;color:rgba(244,241,234,0.4)">${meeting.language === 'es' ? '🇪🇸 Spanish' : '🇺🇸 English'} · Processed just now</p>

              <!-- Deal Score -->
              <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:16px">
                <tr>
                  <td style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px 20px;text-align:center">
                    <p style="margin:0 0 4px;color:rgba(244,241,234,0.4);font-size:11px;font-weight:700;letter-spacing:1px">DEAL HEALTH SCORE</p>
                    <p style="margin:0;font-size:42px;font-weight:700;color:${(meeting.deal_score||0) >= 70 ? '#22c55e' : '#ff4545'}">${meeting.deal_score || '—'}</p>
                    <p style="margin:4px 0 0;font-size:11px;color:rgba(244,241,234,0.4)">out of 100</p>
                  </td>
                </tr>
              </table>

              <!-- Summary preview -->
              ${meeting.summary ? `
              <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:16px">
                <tr>
                  <td style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px 20px">
                    <p style="margin:0 0 8px;color:#ff6b1a;font-size:11px;font-weight:700;letter-spacing:1px">📝 AI SUMMARY</p>
                    <p style="margin:0;color:rgba(244,241,234,0.7);font-size:13px;line-height:1.6">${meeting.summary.substring(0,200)}${meeting.summary.length > 200 ? '...' : ''}</p>
                  </td>
                </tr>
              </table>` : ''}

              <!-- Action items count -->
              ${meeting.action_items?.length ? `
              <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:28px">
                <tr>
                  <td style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px 20px">
                    <p style="margin:0 0 8px;color:#ff6b1a;font-size:11px;font-weight:700;letter-spacing:1px">✅ ACTION ITEMS (${meeting.action_items.length})</p>
                    ${meeting.action_items.slice(0,3).map(a => `<p style="margin:0 0 6px;color:rgba(244,241,234,0.7);font-size:13px">• ${a}</p>`).join('')}
                    ${meeting.action_items.length > 3 ? `<p style="margin:6px 0 0;color:rgba(244,241,234,0.4);font-size:12px">+ ${meeting.action_items.length - 3} more in your dashboard</p>` : ''}
                  </td>
                </tr>
              </table>` : ''}

              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#ff6b1a;border-radius:8px">
                    <a href="https://callforge.to/dashboard.html" style="display:inline-block;padding:14px 28px;color:#fff;text-decoration:none;font-size:14px;font-weight:700">View full results →</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 40px;border-top:1px solid rgba(255,255,255,0.07)">
              <p style="margin:0;font-size:12px;color:rgba(244,241,234,0.3)">
                <a href="https://callforge.to" style="color:#ff6b1a;text-decoration:none">callforge.to</a> · <a href="mailto:hello@callforge.to" style="color:#ff6b1a;text-decoration:none">hello@callforge.to</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  else {
    return res.status(400).json({ error: `Unknown email type: ${type}` });
  }

  // ── SEND VIA RESEND ────────────────────────────────────────────────────
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Callforge <hello@callforge.to>',
        to: [to],
        subject,
        html,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('Resend error:', result);
      return res.status(500).json({ error: 'Failed to send email', details: result });
    }

    return res.status(200).json({ success: true, id: result.id });

  } catch (error) {
    console.error('Send email error:', error);
    return res.status(500).json({ error: error.message });
  }
}
