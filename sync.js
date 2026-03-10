const axios = require('axios');

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
let ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPOSITORY;

let zohoAccessToken = null;

async function updateGitHubSecret(newRefreshToken) {
  try {
    // Get repo public key for secret encryption
    const keyRes = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/secrets/public-key`,
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' } }
    );
    const { key, key_id } = keyRes.data;

    // Use libsodium to encrypt (via Node built-in for simplicity: base64 encode)
    // GitHub requires libsodium encryption - we'll use a workaround via gh CLI in workflow
    // For now just log the new token so workflow can capture it
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
    return res.data;
  } catch (e) {
    console.log(`Zoho ${module} error:`, e.response ? e.response.data : e.message);
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
      await zohoPost('Contacts', {
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

async function syncEmails() {
  console.log('Syncing emails...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100, properties: 'hs_email_subject,hs_email_text,hs_email_html,hs_email_status,hs_email_direction,hs_timestamp,createdate' };
    if (after) params.after = after;
    const res = await hubspotGet('/crm/v3/objects/emails', params);
    for (const e of res.results) {
      const p = e.properties;
      const isOpened = p.hs_email_status === 'OPENED' || p.hs_email_status === 'CLICKED';
      const direction = p.hs_email_direction === 'EMAIL' ? 'Sent' : 'Received';
      const emailBody = p.hs_email_html || p.hs_email_text || '';
      
      await zohoPost('Notes', {
        Note_Title: `📧 ${direction}: ${p.hs_email_subject || 'No Subject'}`,
        Note_Content: `Email ${direction} on ${p.hs_timestamp || p.createdate}\n\nStatus: ${isOpened ? '✅ Opened' : '📬 Sent'}\n\nSubject: ${p.hs_email_subject || 'No Subject'}\n\n${emailBody}`
      });
      total++;
    }
    after = res.paging && res.paging.next ? res.paging.next.after : undefined;
  } while (after);
  console.log(`Synced ${total} emails`);
}

async function main() {
  console.log('Starting HubSpot -> Zoho CRM sync...');
  console.log(new Date().toISOString());
  await getZohoAccessToken();
  await syncContacts();
  await syncCompanies();
  await syncDeals();
  await syncNotes();
  await syncTasks();
  await syncMeetings();
  await syncCalls();
    await syncEmails();
  console.log('Sync complete!');
}

main().catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
