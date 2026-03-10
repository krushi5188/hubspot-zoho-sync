const axios = require('axios');

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;

let zohoAccessToken = null;

async function getZohoAccessToken() {
  const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: {
      refresh_token: ZOHO_REFRESH_TOKEN,
      client_id: ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token'
    }
  });
  zohoAccessToken = res.data.access_token;
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
    console.error(`Zoho ${module} error:`, e.response?.data || e.message);
  }
}

async function syncContacts() {
  console.log('Syncing contacts...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100, properties: 'firstname,lastname,email,phone,company,jobtitle,address,city,state,country,zip,website,lifecyclestage,hs_lead_status,createdate,lastmodifieddate' };
    if (after) params.after = after;
    const data = await hubspotGet('/crm/v3/objects/contacts', params);
    for (const c of data.results) {
      const p = c.properties;
      await zohoPost('Contacts', {
        First_Name: p.firstname || '',
        Last_Name: p.lastname || '(unknown)',
        Email: p.email,
        Phone: p.phone,
        Account_Name: p.company,
        Title: p.jobtitle,
        Mailing_Street: p.address,
        Mailing_City: p.city,
        Mailing_State: p.state,
        Mailing_Country: p.country,
        Mailing_Zip: p.zip,
        Website: p.website,
        Lead_Source: 'HubSpot',
        Description: `HS ID: ${c.id} | Stage: ${p.lifecyclestage || ''}`
      });
      total++;
    }
    after = data.paging?.next?.after;
  } while (after);
  console.log(`Contacts synced: ${total}`);
}

async function syncCompanies() {
  console.log('Syncing companies...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100, properties: 'name,domain,phone,city,state,country,zip,industry,numberofemployees,annualrevenue,description,createdate' };
    if (after) params.after = after;
    const data = await hubspotGet('/crm/v3/objects/companies', params);
    for (const c of data.results) {
      const p = c.properties;
      await zohoPost('Accounts', {
        Account_Name: p.name || 'Unknown',
        Website: p.domain,
        Phone: p.phone,
        Billing_City: p.city,
        Billing_State: p.state,
        Billing_Country: p.country,
        Billing_Code: p.zip,
        Industry: p.industry,
        Employees: p.numberofemployees,
        Annual_Revenue: p.annualrevenue,
        Description: p.description || `HS ID: ${c.id}`
      });
      total++;
    }
    after = data.paging?.next?.after;
  } while (after);
  console.log(`Companies synced: ${total}`);
}

async function syncDeals() {
  console.log('Syncing deals...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100, properties: 'dealname,amount,dealstage,pipeline,closedate,description,createdate,hs_lastmodifieddate' };
    if (after) params.after = after;
    const data = await hubspotGet('/crm/v3/objects/deals', params);
    for (const d of data.results) {
      const p = d.properties;
      await zohoPost('Deals', {
        Deal_Name: p.dealname || 'Unnamed Deal',
        Amount: parseFloat(p.amount) || 0,
        Stage: mapDealStage(p.dealstage),
        Closing_Date: p.closedate ? p.closedate.split('T')[0] : new Date().toISOString().split('T')[0],
        Description: p.description || `HS ID: ${d.id} | Pipeline: ${p.pipeline || ''}`
      });
      total++;
    }
    after = data.paging?.next?.after;
  } while (after);
  console.log(`Deals synced: ${total}`);
}

function mapDealStage(stage) {
  const map = {
    appointmentscheduled: 'Qualification',
    qualifiedtobuy: 'Needs Analysis',
    presentationscheduled: 'Value Proposition',
    decisionmakerboughtin: 'Id. Decision Makers',
    contractsent: 'Perception Analysis',
    closedwon: 'Closed Won',
    closedlost: 'Closed Lost'
  };
  return map[stage] || 'Qualification';
}

async function syncNotes() {
  console.log('Syncing notes...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100, properties: 'hs_note_body,hs_timestamp,createdate' };
    if (after) params.after = after;
    const data = await hubspotGet('/crm/v3/objects/notes', params);
    for (const n of data.results) {
      const p = n.properties;
      if (!p.hs_note_body) continue;
      await zohoPost('Notes', {
        Note_Title: 'Note from HubSpot',
        Note_Content: p.hs_note_body,
        $se_module: 'Contacts'
      });
      total++;
    }
    after = data.paging?.next?.after;
  } while (after);
  console.log(`Notes synced: ${total}`);
}

async function syncTasks() {
  console.log('Syncing tasks...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100, properties: 'hs_task_subject,hs_task_body,hs_task_status,hs_timestamp,hs_task_priority,hs_task_type' };
    if (after) params.after = after;
    const data = await hubspotGet('/crm/v3/objects/tasks', params);
    for (const t of data.results) {
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
    after = data.paging?.next?.after;
  } while (after);
  console.log(`Tasks synced: ${total}`);
}

async function syncMeetings() {
  console.log('Syncing meetings...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100, properties: 'hs_meeting_title,hs_meeting_body,hs_meeting_start_time,hs_meeting_end_time,hs_meeting_outcome' };
    if (after) params.after = after;
    const data = await hubspotGet('/crm/v3/objects/meetings', params);
    for (const m of data.results) {
      const p = m.properties;
      await zohoPost('Events', {
        Event_Title: p.hs_meeting_title || 'Meeting from HubSpot',
        Description: p.hs_meeting_body || '',
        Start_DateTime: p.hs_meeting_start_time || new Date().toISOString(),
        End_DateTime: p.hs_meeting_end_time || new Date().toISOString()
      });
      total++;
    }
    after = data.paging?.next?.after;
  } while (after);
  console.log(`Meetings synced: ${total}`);
}

async function syncCalls() {
  console.log('Syncing calls...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100, properties: 'hs_call_title,hs_call_body,hs_call_direction,hs_call_duration,hs_call_status,hs_timestamp' };
    if (after) params.after = after;
    const data = await hubspotGet('/crm/v3/objects/calls', params);
    for (const c of data.results) {
      const p = c.properties;
      await zohoPost('Calls', {
        Subject: p.hs_call_title || 'Call from HubSpot',
        Description: p.hs_call_body || '',
        Direction: p.hs_call_direction === 'OUTBOUND' ? 'Outbound' : 'Inbound',
        Duration: Math.round((parseInt(p.hs_call_duration) || 0) / 1000 / 60),
        Call_Result: p.hs_call_status || 'Completed',
        Call_Start_Time: p.hs_timestamp || new Date().toISOString()
      });
      total++;
    }
    after = data.paging?.next?.after;
  } while (after);
  console.log(`Calls synced: ${total}`);
}

async function syncEmailActivity() {
  console.log('Syncing email sends...');
  let after = undefined;
  let total = 0;
  do {
    const params = { limit: 100, properties: 'hs_email_subject,hs_email_text,hs_email_status,hs_email_direction,hs_timestamp,hs_email_from_email,hs_email_to_email' };
    if (after) params.after = after;
    const data = await hubspotGet('/crm/v3/objects/emails', params);
    for (const e of data.results) {
      const p = e.properties;
      await zohoPost('Activities', {
        Activity_Type: 'Email',
        Subject: p.hs_email_subject || 'Email from HubSpot',
        Description: `From: ${p.hs_email_from_email || ''} To: ${p.hs_email_to_email || ''}\n\n${p.hs_email_text || ''}`,
        Status: 'Completed'
      });
      total++;
    }
    after = data.paging?.next?.after;
  } while (after);
  console.log(`Emails synced: ${total}`);
}

async function main() {
  console.log('Starting HubSpot -> Zoho CRM sync...');
  console.log(new Date().toISOString());
  try {
    await getZohoAccessToken();
    await syncContacts();
    await syncCompanies();
    await syncDeals();
    await syncNotes();
    await syncTasks();
    await syncMeetings();
    await syncCalls();
    await syncEmailActivity();
    console.log('Sync completed successfully!');
  } catch (err) {
    console.error('Sync failed:', err.message);
    process.exit(1);
  }
}

main();
