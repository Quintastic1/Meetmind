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

        // Use engagements API for notes — works with crm.objects.contacts.write scope
        const notePayload = {
          engagement: {
            active:    true,
            type:      'NOTE',
            timestamp: callDate,
          },
          associations: {
            contactIds: contactId ? [parseInt(contactId)] : [],
            companyIds: [],
            dealIds:    dealId ? [parseInt(dealId)] : [],
            ownerIds:   [],
          },
          metadata: {
            body: noteBody,
          }
        };

        const noteRes = await fetch('https://api.hubapi.com/engagements/v1/engagements', {
          method: 'POST',
          headers,
          body: JSON.stringify(notePayload),
        });

        if (noteRes.ok) {
          const noteData = await noteRes.json();
          results.note = { id: noteData.engagement?.id, action: 'created' };
        } else {
          const noteErr = await noteRes.json();
          console.error('Note creation failed:', noteErr);
          results.note = { action: 'failed', error: noteErr.message };
        }

        // STEP 3: Update or create deal
        let dealId = null;

        // Always create a NEW deal for each meeting sync
        // Each call is its own deal — don't overwrite previous ones
        {
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
                dealname:    `${meeting.title || contactName} — ${new Date(meeting.created_at || Date.now()).toLocaleDateString()}`,
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

        // STEP 4: Create a task for each action item
        const actionItemsArray = Array.isArray(meeting.action_items)
          ? meeting.action_items
          : typeof meeting.action_items === 'string'
            ? meeting.action_items.split('\n').filter(i => i.trim())
            : [];

        const taskResults = [];
        const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // due tomorrow

        for (const item of actionItemsArray.slice(0, 10)) { // max 10 tasks
          if (!item.trim()) continue;
          try {
            // Task payload built below using engagements API

            // Use engagements API for tasks
            const taskPayload = {
              engagement: {
                active:    true,
                type:      'TASK',
                timestamp: dueDate.getTime(),
              },
              associations: {
                contactIds: contactId ? [parseInt(contactId)] : [],
                companyIds: [],
                dealIds:    dealId ? [parseInt(dealId)] : [],
                ownerIds:   [],
              },
              metadata: {
                body:      `Action item from: ${meeting.title || 'Sales Call'}\n\nPowered by Callforge · callforge.to`,
                subject:   item.trim(),
                status:    'NOT_STARTED',
                forObjectType: 'CONTACT',
              }
            };

            const taskRes = await fetch('https://api.hubapi.com/engagements/v1/engagements', {
              method: 'POST',
              headers,
              body: JSON.stringify(taskPayload),
            });

            if (taskRes.ok) {
              const taskData = await taskRes.json();
              taskResults.push({ id: taskData.engagement?.id, subject: item.trim() });
            } else {
              const taskErr = await taskRes.json();
              console.error('Task creation failed:', taskErr.message);
            }
          } catch(taskErr) {
            console.error('Task error:', taskErr);
          }
        }

        results.tasks = taskResults;

        return res.status(200).json({
          success: true,
          message: 'Meeting synced to HubSpot',
          results,
          hubspot_contact_id: contactId,
          hubspot_deal_id:    dealId,
          tasks_created:      taskResults.length,
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
