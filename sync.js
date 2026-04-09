const axios = require('axios');

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
let ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const GITHUB_TOKEN = process.env.GH_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPOSITORY;

let zohoAccessToken = null;
const zohoContactMap = {};

async function getZohoAccessToken() {
  const params = new URLSearchParams();
  params.append('refresh_token', ZOHO_REFRESH_TOKEN);
  params.append('client_id', ZOHO_CLIENT_ID);
  params.append('client_secret', ZOHO_CLIENT_SECRET);
  params.append('grant_type', 'refresh_token');

  const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', params);

  if (!res.data.access_token) {
    throw new Error('Token refresh failed: ' + JSON.stringify(res.data));
  }

  zohoAccessToken = res.data.access_token;

  if (res.data.refresh_token) {
    ZOHO_REFRESH_TOKEN = res.data.refresh_token;
    console.log(`NEW_REFRESH_TOKEN=${res.data.refresh_token}`);
  }

  console.log('Zoho access token refreshed');
}

async function hubspotGet(path, params = {}) {
  const res = await axios.get(`https://api.hubapi.com${path}`, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
    params
  });
  return res.data;
}

async function zohoPost(module, data) {
  try {
    // Determine which field makes this record unique based on the module
    let checkFields = [];
    if (module === 'Contacts') checkFields = ['Email'];
    if (module === 'Accounts') checkFields = ['Account_Name'];
    if (module === 'Deals') checkFields = ['Deal_Name'];
    
    const payload = { 
      data: [data]
    };
    
    // Only add the duplicate check flag if we defined one
    if (checkFields.length > 0) {
      payload.duplicate_check_fields = checkFields;
    }

    const res = await axios.post(
      `https://www.zohoapis.in/crm/v2/${module}/upsert`,
      payload,
      { headers: { Authorization: `Zoho-oauthtoken ${zohoAccessToken}` } }
    );
    if (res.data?.data?.[0]?.details) return res.data.data[0].details.id;
    return res.data;
  } catch (e) {
    console.log(`Zoho ${module} error:`, e.response ? JSON.stringify(e.response.data) : e.message);
    return null;
  }
}

async function syncContacts() {
  console.log('Syncing contacts...');
  let after, total = 0;
  do {
    const params = { limit: 100, properties: 'firstname,lastname,email,phone,company,jobtitle,website,address,city,state,country,zip' };
    if (after) params.after = after;
    const res = await hubspotGet('/crm/v3/objects/contacts', params);
    for (const c of res.results) {
      const p = c.properties;
      const zohoId = await zohoPost('Contacts', {
        First_Name: p.firstname || '',
        Last_Name: p.lastname || 'Unknown',
        Email: p.email || '',
        Phone: p.phone || '',
        Account_Name: p.company || '',
        Title: p.jobtitle || '',
        Lead_Source: 'HubSpot'
      });
      if (zohoId) zohoContactMap[c.id] = zohoId;
      total++;
    }
    after = res.paging?.next?.after;
  } while (after);
  console.log(`Synced ${total} contacts`);
}

async function syncCompanies() {
  console.log('Syncing companies...');
  let after, total = 0;
  do {
    const params = { limit: 100, properties: 'name,domain,phone,industry,city,state,country,zip,numberofemployees,annualrevenue,description' };
    if (after) params.after = after;
    const res = await hubspotGet('/crm/v3/objects/companies', params);
    for (const c of res.results) {
      const p = c.properties;
      await zohoPost('Accounts', {
        Account_Name: p.name || 'Unknown',
        Website: p.domain || '',
        Phone: p.phone || '',
        Industry: p.industry || ''
      });
      total++;
    }
    after = res.paging?.next?.after;
  } while (after);
  console.log(`Synced ${total} companies`);
}

async function syncDeals() {
  console.log('Syncing deals...');
  const stageMap = {
    appointmentscheduled: 'Qualification', qualifiedtobuy: 'Needs Analysis',
    presentationscheduled: 'Value Proposition', decisionmakerboughtin: 'Id. Decision Makers',
    contractsent: 'Perception Analysis', closedwon: 'Closed Won', closedlost: 'Closed Lost'
  };
  let after, total = 0;
  do {
    const params = { limit: 100, properties: 'dealname,amount,dealstage,closedate,description' };
    if (after) params.after = after;
    const res = await hubspotGet('/crm/v3/objects/deals', params);
    for (const d of res.results) {
      const p = d.properties;
      await zohoPost('Deals', {
        Deal_Name: p.dealname || 'Untitled Deal',
        Amount: parseFloat(p.amount) || 0,
        Stage: stageMap[p.dealstage] || 'Qualification',
        Closing_Date: p.closedate ? p.closedate.split('T')[0] : new Date().toISOString().split('T')[0]
      });
      total++;
    }
    after = res.paging?.next?.after;
  } while (after);
  console.log(`Synced ${total} deals`);
}

async function syncMeetings() {
  console.log('Syncing meetings...');
  let after, total = 0;
  do {
    const params = { limit: 100, properties: 'hs_meeting_title,hs_meeting_body,hs_meeting_start_time,hs_meeting_end_time' };
    if (after) params.after = after;
    const res = await hubspotGet('/crm/v3/objects/meetings', params);
    for (const m of res.results) {
      const p = m.properties;
      await zohoPost('Events', {
        Event_Title: p.hs_meeting_title || 'Meeting from HubSpot',
        Description: p.hs_meeting_body || '',
        Start_DateTime: p.hs_meeting_start_time || new Date().toISOString(),
        End_DateTime: p.hs_meeting_end_time || new Date().toISOString()
      });
      total++;
    }
    after = res.paging?.next?.after;
  } while (after);
  console.log(`Synced ${total} meetings`);
}

async function syncCalls() {
  console.log('Syncing calls...');
  let after, total = 0;
  do {
    const params = { limit: 100, properties: 'hs_call_title,hs_call_body,hs_call_duration,hs_call_status,hs_timestamp' };
    if (after) params.after = after;
    const res = await hubspotGet('/crm/v3/objects/calls', params);
    for (const c of res.results) {
      const p = c.properties;
      await zohoPost('Calls', {
        Subject: p.hs_call_title || 'Call from HubSpot',
        Description: p.hs_call_body || '',
        Duration: p.hs_call_duration ? Math.floor(parseInt(p.hs_call_duration) / 60000) + ' minutes' : '0 minutes',
        Call_Start_Time: p.hs_timestamp || new Date().toISOString()
      });
      total++;
    }
    after = res.paging?.next?.after;
  } while (after);
  console.log(`Synced ${total} calls`);
}

async function syncNotes() {
  console.log('Syncing notes...');
  let after, total = 0;
  do {
    const params = { limit: 100, properties: 'hs_note_body,hs_timestamp,createdate' };
    if (after) params.after = after;
    const res = await hubspotGet('/crm/v3/objects/notes', params);
    for (const n of res.results) {
      const p = n.properties;
      await zohoPost('Notes', {
        Note_Title: p.hs_note_body ? p.hs_note_body.substring(0, 100) : 'Note from HubSpot',
        Note_Content: p.hs_note_body || ''
      });
      total++;
    }
    after = res.paging?.next?.after;
  } while (after);
  console.log(`Synced ${total} notes`);
}

async function syncTasks() {
  console.log('Syncing tasks...');
  let after, total = 0;
  do {
    const params = { limit: 100, properties: 'hs_task_subject,hs_task_body,hs_task_status,hs_task_priority,hs_timestamp' };
    if (after) params.after = after;
    const res = await hubspotGet('/crm/v3/objects/tasks', params);
    for (const t of res.results) {
      const p = t.properties;
      await zohoPost('Tasks', {
        Subject: p.hs_task_subject || 'Task from HubSpot',
        Description: p.hs_task_body || '',
        Status: p.hs_task_status === 'COMPLETED' ? 'Completed' : 'Not Started',
        Priority: p.hs_task_priority === 'HIGH' ? 'High' : 'Normal',
        Due_Date: p.hs_timestamp ? p.hs_timestamp.split('T')[0] : new Date().toISOString().split('T')[0]
      });
      total++;
    }
    after = res.paging?.next?.after;
  } while (after);
  console.log(`Synced ${total} tasks`);
}

async function syncEmailsAsNotes() {
  console.log('Syncing emails as notes...');
  
  // --- SPEED OPTIMIZATION: Cache existing Zoho Notes ---
  console.log('Caching existing Zoho Notes...');
  const existingZohoNotes = {};
  let notesPage = 1;
  let hasMoreNotes = true;
  
  while (hasMoreNotes) {
    try {
      const notesRes = await axios.get(`https://www.zohoapis.in/crm/v2/Notes?page=${notesPage}&per_page=200`, {
        headers: { Authorization: `Zoho-oauthtoken ${zohoAccessToken}` }
      });
      const notesData = notesRes.data.data || [];
      for (const note of notesData) {
        if (note.Parent_Id && note.Parent_Id.id) {
          const parentId = note.Parent_Id.id;
          if (!existingZohoNotes[parentId]) existingZohoNotes[parentId] = [];
          existingZohoNotes[parentId].push(note);
        }
      }
      hasMoreNotes = notesRes.data.info.more_records;
      notesPage++;
    } catch (e) {
      hasMoreNotes = false;
    }
  }

  let after, total = 0;
  do {
    const params = {
      limit: 100,
      properties: [
        'hs_email_subject',
        'hs_email_text',
        'hs_email_html',
        'hs_email_status',
        'hs_email_direction',
        'hs_email_from_email',
        'hs_email_from_firstname',
        'hs_email_from_lastname',
        'hs_email_to_email',
        'hs_email_to_firstname',
        'hs_email_to_lastname',
        'hs_timestamp',
        'createdate'
      ].join(',')
    };
    if (after) params.after = after;
    const res = await hubspotGet('/crm/v3/objects/emails', params);
    
    // Batch fetch associations for speed
    const emailIds = res.results.map(e => ({ id: e.id }));
    let assocMap = {};
    if (emailIds.length > 0) {
      try {
        const assocRes = await axios.post(
          'https://api.hubapi.com/crm/v3/associations/emails/contacts/batch/read',
          { inputs: emailIds },
          { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
        );
        for (const assoc of assocRes.data.results || []) {
          if (assoc.to && assoc.to.length > 0) {
            assocMap[assoc.from.id] = assoc.to[0].id;
          }
        }
      } catch (e) {}
    }

    for (const email of res.results) {
      const p = email.properties;

      const fromName = [p.hs_email_from_firstname, p.hs_email_from_lastname].filter(Boolean).join(' ') || p.hs_email_from_email || 'Unknown';
      const toName = [p.hs_email_to_firstname, p.hs_email_to_lastname].filter(Boolean).join(' ') || p.hs_email_to_email || 'Unknown';
      const direction = p.hs_email_direction || 'EMAIL';
      const status = p.hs_email_status || 'SENT';
      const subject = p.hs_email_subject || '(No Subject)';
      const body = p.hs_email_text || p.hs_email_html || '(No Body)';
      const timestamp = p.hs_timestamp ? new Date(p.hs_timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '';

      const noteTitle = `[Email] ${subject}`.substring(0, 255);
      const idTag = `[HS_ID:${email.id}]`;
      
      const fullNoteContent = [
        `Direction: ${direction}`,
        `Status: ${status}`,
        `From: ${fromName}${p.hs_email_from_email ? ' <' + p.hs_email_from_email + '>' : ''}`,
        `To: ${toName}${p.hs_email_to_email ? ' <' + p.hs_email_to_email + '>' : ''}`,
        timestamp ? `Date: ${timestamp}` : '',
        '',
        body,
        '',
        idTag
      ].filter(line => line !== null && line !== undefined).join('\n');

      const hubspotContactId = assocMap[email.id];
      const zohoContactId = hubspotContactId ? zohoContactMap[hubspotContactId] : null;

      if (zohoContactId) {
        const contactNotes = existingZohoNotes[zohoContactId] || [];
        const existingEmailNote = contactNotes.find(n => n.Note_Content && n.Note_Content.includes(idTag));

        if (existingEmailNote) {
          // UPDATE the existing note only if the status changed (e.g. from SENT to OPENED)
          if (!existingEmailNote.Note_Content.includes(`Status: ${status}`)) {
            await axios.put(
              `https://www.zohoapis.in/crm/v2/Notes/${existingEmailNote.id}`,
              { data: [{ Note_Title: noteTitle, Note_Content: fullNoteContent }] },
              { headers: { Authorization: `Zoho-oauthtoken ${zohoAccessToken}` } }
            );
          }
        } else {
          // CREATE a new note
          await axios.post(
            `https://www.zohoapis.in/crm/v2/Notes`,
            { data: [{ Note_Title: noteTitle, Note_Content: fullNoteContent, Parent_Id: zohoContactId, se_module: 'Contacts' }] },
            { headers: { Authorization: `Zoho-oauthtoken ${zohoAccessToken}` } }
          );
        }
      } else {
        await zohoPost('Notes', {
          Note_Title: noteTitle,
          Note_Content: fullNoteContent
        });
      }
      total++;
    }
    after = res.paging?.next?.after;
  } while (after);
  console.log(`Synced ${total} emails as notes`);
}

async function main() {
  console.log('Starting HubSpot to Zoho sync...');
  try {
    await getZohoAccessToken();
    await syncContacts();
    await syncCompanies();
    await syncDeals();
    await syncMeetings();
    await syncCalls();
    await syncNotes();
    await syncTasks();
    await syncEmailsAsNotes();
    console.log('\n=== Sync completed successfully! ===');
  } catch (error) {
    console.error('Sync failed:', error);
    process.exit(1);
  }
}

main();
