// api/hubspot.js
// Callforge HubSpot CRM Integration
// Syncs call summaries, action items, and deal scores to HubSpot

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, hubspot_token, meeting, prospect } = req.body;

  if (!hubspot_token) {
    return res.status(400).json({ error: 'HubSpot token required' });
  }

  const headers = {
    'Authorization': `Bearer ${hubspot_token}`,
    'Content-Type': 'application/json',
  };

  try {
    switch(action) {

      // ── TEST CONNECTION ────────────────────────────────────────────────
      case 'test': {
        const testRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', {
          headers
        });
        if (!testRes.ok) {
          const err = await testRes.json();
          return res.status(400).json({ 
            success: false, 
            error: err.message || 'Invalid token or insufficient permissions' 
          });
        }
        return res.status(200).json({ success: true, message: 'HubSpot connected successfully!' });
      }

      // ── SYNC MEETING TO HUBSPOT ────────────────────────────────────────
      case 'sync': {
        if (!meeting) {
          return res.status(400).json({ error: 'Meeting data required' });
        }

        const results = {};

        // STEP 1: Find or create contact
        const contactName  = prospect?.name || meeting.title?.split('—')[0]?.trim() || 'Unknown';
        const contactEmail = prospect?.email || null;
        const contactParts = contactName.split(' ');
        const firstName    = contactParts[0] || '';
        const lastName     = contactParts.slice(1).join(' ') || '';

        let contactId = null;

        // Try to find existing contact by email first
        if (contactEmail) {
          const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              filterGroups: [{
                filters: [{
                  propertyName: 'email',
                  operator: 'EQ',
                  value: contactEmail
                }]
              }]
            })
          });
          const searchData = await searchRes.json();
          if (searchData.results?.length > 0) {
            contactId = searchData.results[0].id;
            results.contact = { id: contactId, action: 'found' };
          }
        }

        // If not found by email, search by name
        if (!contactId) {
          const nameSearchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              filterGroups: [{
                filters: [{
                  propertyName: 'firstname',
                  operator: 'EQ',
                  value: firstName
                }]
              }]
            })
          });
          const nameData = await nameSearchRes.json();
          if (nameData.results?.length > 0) {
            contactId = nameData.results[0].id;
            results.contact = { id: contactId, action: 'found_by_name' };
          }
        }

        // Create new contact if not found
        if (!contactId) {
          const createContactRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              properties: {
                firstname: firstName,
                lastname:  lastName,
                email:     contactEmail || '',
                hs_lead_status: 'IN_PROGRESS',
              }
            })
          });
          const newContact = await createContactRes.json();
          contactId = newContact.id;
          results.contact = { id: contactId, action: 'created' };
        }

        // STEP 2: Log the call as an engagement/note
        const callDate   = new Date(meeting.created_at || Date.now()).getTime();
        const dealScore  = meeting.deal_score || 0;
        const language   = meeting.language === 'es' ? '🇪🇸 Spanish' : '🇺🇸 English';
        const actionItems = Array.isArray(meeting.action_items) 
          ? meeting.action_items.join('\n• ') 
          : meeting.action_items || 'None extracted';

        const noteBody = `⚒ CALLFORGE CALL ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📞 Call: ${meeting.title || 'Sales Call'}
📅 Date: ${new Date(meeting.created_at || Date.now()).toLocaleDateString()}
🌐 Language: ${language}
🎯 Deal Score: ${dealScore}/100

📋 SUMMARY
${meeting.summary || 'No summary available'}

✅ ACTION ITEMS
• ${actionItems}

📧 FOLLOW-UP EMAIL DRAFTED
${meeting.follow_up_email || 'No follow-up drafted'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Powered by Callforge · callforge.to`;

        const noteRes = await fetch('https://api.hubapi.com/crm/v3/objects/notes', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            properties: {
              hs_note_body:      noteBody,
              hs_timestamp:      callDate.toString(),
              hs_attachment_ids: '',
            },
            associations: [
              {
                to: { id: contactId },
                types: [{
                  associationCategory: 'HUBSPOT_DEFINED',
                  associationTypeId: 202
                }]
              }
            ]
          })
        });

        if (noteRes.ok) {
          const noteData = await noteRes.json();
          results.note = { id: noteData.id, action: 'created' };
        } else {
          // Fallback: create as a regular note without association
          const fallbackNote = await fetch('https://api.hubapi.com/crm/v3/objects/notes', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              properties: {
                hs_note_body:  noteBody,
                hs_timestamp:  callDate.toString(),
              }
            })
          });
          const fallbackData = await fallbackNote.json();
          results.note = { id: fallbackData.id, action: 'created_unassociated' };
        }

        // STEP 3: Update or create deal
        let dealId = null;

        // Search for existing deal linked to this contact
        const dealSearchRes = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            filterGroups: [{
              filters: [{
                propertyName: 'dealname',
                operator: 'CONTAINS_TOKEN',
                value: firstName
              }]
            }],
            limit: 1
          })
        });
        const dealSearchData = await dealSearchRes.json();

        if (dealSearchData.results?.length > 0) {
          // Update existing deal
          dealId = dealSearchData.results[0].id;
          await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              properties: {
                description: `Deal Score: ${dealScore}/100\n\n${meeting.summary || ''}`,
                hs_priority: dealScore >= 70 ? 'high' : dealScore >= 50 ? 'medium' : 'low',
              }
            })
          });
          results.deal = { id: dealId, action: 'updated' };
        } else {
          // Create new deal
          const stageMap = {
            90: 'closedwon',
            70: 'presentationscheduled',
            50: 'appointmentscheduled',
            30: 'qualifiedtobuy',
            0:  'appointmentscheduled'
          };
          const stage = Object.entries(stageMap)
            .reverse()
            .find(([score]) => dealScore >= parseInt(score))?.[1] || 'appointmentscheduled';

          const createDealRes = await fetch('https://api.hubapi.com/crm/v3/objects/deals', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              properties: {
                dealname:    `${contactName} — Callforge Deal`,
                dealstage:   stage,
                description: `Deal Score: ${dealScore}/100\n\n${meeting.summary || ''}`,
                hs_priority: dealScore >= 70 ? 'high' : dealScore >= 50 ? 'medium' : 'low',
                closedate:   new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
              },
              associations: contactId ? [{
                to: { id: contactId },
                types: [{
                  associationCategory: 'HUBSPOT_DEFINED',
                  associationTypeId: 3
                }]
              }] : []
            })
          });
          const newDeal = await createDealRes.json();
          dealId = newDeal.id;
          results.deal = { id: dealId, action: 'created' };
        }

        return res.status(200).json({
          success: true,
          message: 'Meeting synced to HubSpot',
          results,
          hubspot_contact_id: contactId,
          hubspot_deal_id:    dealId,
          hubspot_url: `https://app.hubspot.com/contacts/${contactId}`,
        });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

  } catch (error) {
    console.error('HubSpot sync error:', error);
    return res.status(500).json({ error: error.message });
  }
}
