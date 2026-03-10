const axios = require('axios');

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
let ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPOSITORY;

let zohoAccessToken = null;
const zohoContactMap = {}; // Store HubSpot contact ID -> Zoho contact ID mapping

async function updateGitHubSecret(newRefreshToken) {
  try {
    const keyRes = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/secrets/public-key`,
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' } }
    );
    const { key, key_id } = keyRes.data;
    console.log(`NEW_REFRESH_TOKEN=${newRefreshToken}`);
  } catch (e) {
    console.log('Could not update GitHub secret:', e.message);
  }
}

async function getZohoAccessToken() {
  const params = new URLSearchParams();
  params.append('refresh_token', ZOHO_REFRESH_TOKEN);
  params.append('client_id', ZOHO_CLIENT_ID);
  params.append('client_secret', ZOHO_CLIENT_SECRET);
  params.append('grant_type', 'refresh_token');

  const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', params);
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
    const res = await axios.post(
      `https://www.zohoapis.in/crm/v2/${module}`,
      { data: [data] },
      { headers: { Authorization: `Zoho-oauthtoken ${zohoAccessToken}` } }
    );
    // Return the created record ID if successful
    if (res.data && res.data.data && res.data.data[0] && res.data.data[0].details) {
      return res.data.data[0].details.id;
    }
    return res.data;
  } catch (e) {
    console.log(`Zoho ${module} error:`, e.response ? JSON.stringify(e.response.data) : e.message);
    return null;
  }
}

async function syncContacts() {
  console.log('Syncing contacts...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100, properties: 'firstname,lastname,email,phone,company,jobtitle,website,address,city,state,country,zip,lifecyclestage,hs_lead_status,notes_last_contacted,createdate' };
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
        Website: p.website || '',
        Mailing_Street: p.address || '',
        Mailing_City: p.city || '',
        Mailing_State: p.state || '',
        Mailing_Country: p.country || '',
        Mailing_Zip: p.zip || '',
        Lead_Source: 'HubSpot'
      });
      // Store mapping: HubSpot contact ID -> Zoho contact ID
      if (zohoId) {
        zohoContactMap[c.id] = zohoId;
      }
      total++;
    }
    after = res.paging && res.paging.next ? res.paging.next.after : undefined;
  } while (after);
  console.log(`Synced ${total} contacts`);
}

async function syncCompanies() {
  console.log('Syncing companies...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100, properties: 'name,domain,phone,industry,city,state,country,zip,numberofemployees,annualrevenue,description,createdate' };
    if (after) params.after = after;
    const res = await hubspotGet('/crm/v3/objects/companies', params);
    for (const c of res.results) {
      const p = c.properties;
      await zohoPost('Accounts', {
        Account_Name: p.name || 'Unknown',
        Website: p.domain || '',
        Phone: p.phone || '',
        Industry: p.industry || '',
        Billing_City: p.city || '',
        Billing_State: p.state || '',
        Billing_Country: p.country || '',
        Billing_Code: p.zip || '',
        Employees: p.numberofemployees || '',
        Annual_Revenue: p.annualrevenue || '',
        Description: p.description || ''
      });
      total++;
    }
    after = res.paging && res.paging.next ? res.paging.next.after : undefined;
  } while (after);
  console.log(`Synced ${total} companies`);
}

async function syncDeals() {
  console.log('Syncing deals...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100, properties: 'dealname,amount,dealstage,pipeline,closedate,hubspot_owner_id,description,createdate' };
    if (after) params.after = after;
    const res = await hubspotGet('/crm/v3/objects/deals', params);
    for (const d of res.results) {
      const p = d.properties;
      const stageMap = {
        'appointmentscheduled': 'Qualification',
        'qualifiedtobuy': 'Needs Analysis',
        'presentationscheduled': 'Value Proposition',
        'decisionmakerboughtin': 'Id. Decision Makers',
        'contractsent': 'Perception Analysis',
        'closedwon': 'Closed Won',
        'closedlost': 'Closed Lost'
      };
      await zohoPost('Deals', {
        Deal_Name: p.dealname || 'Untitled Deal',
        Amount: parseFloat(p.amount) || 0,
        Stage: stageMap[p.dealstage] || 'Qualification',
        Closing_Date: p.closedate ? p.closedate.split('T')[0] : new Date().toISOString().split('T')[0],
        Description: p.description || ''
      });
      total++;
    }
    after = res.paging && res.paging.next ? res.paging.next.after : undefined;
  } while (after);
  console.log(`Synced ${total} deals`);
}

async function syncNotes() {
  console.log('Syncing notes...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100, properties: 'hs_note_body,hs_timestamp,createdate' };
    if (after) params.after = after;
    const res = await hubspotGet('/crm/v3/objects/notes', params);
    for (const n of res.results) {
      const p = n.properties;
      await zohoPost('Notes', {
        Note_Title: 'Note from HubSpot',
        Note_Content: p.hs_note_body || ''
      });
      total++;
    }
    after = res.paging && res.paging.next ? res.paging.next.after : undefined;
  } while (after);
  console.log(`Synced ${total} notes`);
}

async function syncTasks() {
  console.log('Syncing tasks...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100, properties: 'hs_task_subject,hs_task_body,hs_task_status,hs_task_priority,hs_timestamp,createdate' };
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
    after = res.paging && res.paging.next ? res.paging.next.after : undefined;
  } while (after);
  console.log(`Synced ${total} tasks`);
}

async function syncMeetings() {
  console.log('Syncing meetings...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100, properties: 'hs_meeting_title,hs_meeting_body,hs_meeting_start_time,hs_meeting_end_time,hs_meeting_outcome,createdate' };
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
    after = res.paging && res.paging.next ? res.paging.next.after : undefined;
  } while (after);
  console.log(`Synced ${total} meetings`);
}

async function syncCalls() {
  console.log('Syncing calls...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100, properties: 'hs_call_title,hs_call_body,hs_call_duration,hs_call_status,hs_call_direction,hs_timestamp,createdate' };
    if (after) params.after = after;
    const res = await hubspotGet('/crm/v3/objects/calls', params);
    for (const c of res.results) {
      const p = c.properties;
      await zohoPost('Calls', {
        Subject: p.hs_call_title || 'Call from HubSpot',
        Description: p.hs_call_body || '',
        Duration: p.hs_call_duration ? Math.floor(parseInt(p.hs_call_duration) / 1000 / 60) + ' minutes' : '0 minutes',
        Call_Result: p.hs_call_status || '',
        Call_Start_Time: p.hs_timestamp || new Date().toISOString()
      });
      total++;
    }
    after = res.paging && res.paging.next ? res.paging.next.after : undefined;
  } while (after);
  console.log(`Synced ${total} calls`);
}

async function syncNotes() {
  console.log('Syncing notes...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100 };
    if (after) params.after = after;
    const res = await hubspotGet('/crm/v3/objects/notes', params);
    for (const note of res.results) {
      const n = note.properties;
      await zohoPost('Notes', {
        Note_Title: n.hs_note_body ? n.hs_note_body.substring(0, 100) : 'Note from HubSpot',
        Note_Content: n.hs_note_body || '',
        Created_Time: n.hs_createdate ? new Date(n.hs_createdate).toISOString() : new Date().toISOString()
      });
      total++;
    }
    after = res.paging && res.paging.next ? res.paging.next.after : undefined;
  } while (after);
  console.log(`Synced ${total} notes`);
}

async function syncTasks() {
  console.log('Syncing tasks...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100 };
    if (after) params.after = after;
    const res = await hubspotGet('/crm/v3/objects/tasks', params);
    for (const task of res.results) {
      const t = task.properties;
      await zohoPost('Tasks', {
        Subject: t.hs_task_subject || 'Task from HubSpot',
        Status: t.hs_task_status || 'Not Started',
        Priority: t.hs_task_priority || 'Normal',
        Due_Date: t.hs_task_due_date ? new Date(parseInt(t.hs_task_due_date)).toISOString().split('T')[0] : null
      });
      total++;
    }
    after = res.paging && res.paging.next ? res.paging.next.after : undefined;
  } while (after);
  console.log(`Synced ${total} tasks`);
}

async function syncEmails() {
  console.log('Syncing emails...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100 };
    if (after) params.after = after;
    const res = await hubspotGet('/crm/v3/objects/emails', params);
    for (const email of res.results) {
      const e = email.properties;
      await zohoPost('Activities', {
        Subject: e.hs_email_subject || 'Email from HubSpot',
        Activity_Type: 'Email',
        Description: e.hs_email_text || '',
        Status: e.hs_email_status || 'Sent',
        Sent_Time: e.hs_email_sent_via ? new Date(e.hs_email_sent_via).toISOString() : new Date().toISOString()
      });
      total++;
    }
    after = res.paging && res.paging.next ? res.paging.next.after : undefined;
  } while (after);
  console.log(`Synced ${total} emails`);
}

async function syncEngagements() {
  console.log('Syncing engagements...');
  try {
    const types = ['meetings', 'calls', 'emails', 'notes', 'tasks'];
    for (const type of types) {
      console.log(`Syncing ${type}...`);
      let after = undefined;
      let total = 0;
      do {
        const params = { limit: 100 };
        if (after) params.after = after;
        const res = await hubspotGet(`/engagements/v1/${type}/paged`, params);
        if (res.results) {
          for (const engagement of res.results) {
            const e = engagement.engagement;
            await zohoPost('Activities', {
              Subject: `${type} - ${e.id}`,
              Activity_Type: type,
              Created_Time: e.createdAt ? new Date(e.createdAt).toISOString() : new Date().toISOString(),
              Description: JSON.stringify(engagement.metadata || {})
            });
            total++;
          }
        }
        after = res.hasMore ? res.offset : undefined;
      } while (after);
      console.log(`Synced ${total} ${type}`);
    }
  } catch (error) {
    console.log('Engagements sync error:', error.message);
  }
}

async function main() {
  console.log('Starting HubSpot to Zoho sync...');
  try {
    await syncContacts();
    await syncCompanies();
    await syncDeals();
    await syncMeetings();
    await syncCalls();
    await syncNotes();
    await syncTasks();
    await syncEmails();
    await syncEngagements();
    console.log('\n=== Sync completed successfully! ===');
  } catch (error) {
    console.error('Sync failed:', error);
    process.exit(1);
  }
}

main();
