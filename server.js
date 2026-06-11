const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// File paths
const leadsFilePath = path.join(__dirname, "leads.json");
const crmFilePath = path.join(__dirname, "fake-crm.json");

// Load JSON file
function loadJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify([], null, 2));
  }

  const fileData = fs.readFileSync(filePath, "utf8");

  if (!fileData) {
    return [];
  }

  try {
    return JSON.parse(fileData);
  } catch (error) {
    return [];
  }
}

// Save JSON file
function saveJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Databases loaded from files
let leads = loadJsonFile(leadsFilePath);
let crmContacts = loadJsonFile(crmFilePath);

// Save leads
function saveLeads() {
  saveJsonFile(leadsFilePath, leads);
}

// Save CRM contacts
function saveCrmContacts() {
  saveJsonFile(crmFilePath, crmContacts);
}

// Generate next lead ID
function getNextLeadId() {
  if (leads.length === 0) {
    return 1;
  }

  const ids = leads.map((lead) => lead.id);
  return Math.max(...ids) + 1;
}

// Generate next CRM contact ID
function getNextCrmId() {
  if (crmContacts.length === 0) {
    return 1;
  }

  const ids = crmContacts.map((contact) => contact.id);
  return Math.max(...ids) + 1;
}

// Normalize email
function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

// Add activity log to a lead
function addLog(lead, action, details) {
  if (!lead.logs) {
    lead.logs = [];
  }

  lead.logs.push({
    action: action,
    details: details,
    createdAt: new Date().toISOString()
  });
}

// Generate lead summary
function generateSummary(lead) {
  return `${lead.name} requested ${lead.service}. Phone: ${lead.phone}. Status: ${lead.status}.`;
}

// Generate email draft
function generateEmailDraft(lead) {
  return {
    to: lead.email,
    subject: "We received your request",
    body: `Hi ${lead.name},

Thanks for contacting us about ${lead.service}.

We received your request and our team will contact you soon.

Best,
Company Team`
  };
}

// Send lead to local fake CRM API
async function sendLeadToLocalFakeCRM(lead) {
  const response = await fetch("http://localhost:3000/fake-crm/contacts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      service: lead.service,
      summary: lead.summary,
      sourceLeadId: lead.id
    })
  });

  if (!response.ok) {
    throw new Error(`CRM API failed with status ${response.status}`);
  }

  const data = await response.json();

  return {
    crmSynced: true,
    crmId: data.data.id,
    crmResponse: data
  };
}

// Test route
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Server is running"
  });
});

// Dashboard summary
app.get("/dashboard", (req, res) => {
  const totalLeads = leads.length;

  const newLeads = leads.filter((lead) => lead.status === "New Lead").length;

  const repliedLeads = leads.filter((lead) => lead.status === "Replied").length;

  const crmSyncedLeads = leads.filter((lead) => lead.crmSynced === true).length;

  const crmFailedLeads = leads.filter((lead) => lead.crmSynced === false).length;

  const duplicateBlocked = leads.reduce((total, lead) => {
    if (!lead.logs) {
      return total;
    }

    const duplicateLogs = lead.logs.filter((log) => {
      return log.action === "Duplicate lead blocked";
    });

    return total + duplicateLogs.length;
  }, 0);

  const leadsByService = {};

  leads.forEach((lead) => {
    if (!leadsByService[lead.service]) {
      leadsByService[lead.service] = 0;
    }

    leadsByService[lead.service]++;
  });

  const latestLeads = [...leads]
    .sort((a, b) => {
      return new Date(b.createdAt) - new Date(a.createdAt);
    })
    .slice(0, 5);

  res.json({
    success: true,
    data: {
      totalLeads: totalLeads,
      newLeads: newLeads,
      repliedLeads: repliedLeads,
      crmSyncedLeads: crmSyncedLeads,
      crmFailedLeads: crmFailedLeads,
      duplicateBlocked: duplicateBlocked,
      leadsByService: leadsByService,
      latestLeads: latestLeads
    }
  });
});

// -------------------- FAKE CRM ROUTES --------------------

// Get all CRM contacts
app.get("/fake-crm/contacts", (req, res) => {
  res.json({
    success: true,
    count: crmContacts.length,
    data: crmContacts
  });
});

// Get one CRM contact
app.get("/fake-crm/contacts/:id", (req, res) => {
  const contactId = Number(req.params.id);

  const contact = crmContacts.find((contact) => contact.id === contactId);

  if (!contact) {
    return res.status(404).json({
      success: false,
      message: "CRM contact not found"
    });
  }

  res.json({
    success: true,
    data: contact
  });
});

// Create CRM contact
app.post("/fake-crm/contacts", (req, res) => {
  const contact = req.body;

  if (!contact.name || !contact.email || !contact.phone) {
    return res.status(400).json({
      success: false,
      message: "Missing required CRM contact data"
    });
  }

  const newContact = {
    id: getNextCrmId(),
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    service: contact.service || "Not provided",
    summary: contact.summary || "Not provided",
    sourceLeadId: contact.sourceLeadId || null,
    crmStatus: "Created",
    createdAt: new Date().toISOString()
  };

  crmContacts.push(newContact);
  saveCrmContacts();

  res.status(201).json({
    success: true,
    message: "CRM contact created successfully",
    data: newContact
  });
});

// -------------------- LEAD ROUTES --------------------

// Get all saved leads with search and filters
app.get("/leads", (req, res) => {
  const status = req.query.status;
  const service = req.query.service;
  const email = req.query.email;
  const search = req.query.search;

  let filteredLeads = leads;

  if (status) {
    filteredLeads = filteredLeads.filter((lead) => {
      return lead.status.toLowerCase() === status.toLowerCase();
    });
  }

  if (service) {
    filteredLeads = filteredLeads.filter((lead) => {
      return lead.service.toLowerCase() === service.toLowerCase();
    });
  }

  if (email) {
    filteredLeads = filteredLeads.filter((lead) => {
      return lead.email.toLowerCase() === email.toLowerCase();
    });
  }

  if (search) {
    filteredLeads = filteredLeads.filter((lead) => {
      const searchValue = search.toLowerCase();

      return (
        lead.name.toLowerCase().includes(searchValue) ||
        lead.email.toLowerCase().includes(searchValue) ||
        lead.phone.toLowerCase().includes(searchValue) ||
        lead.service.toLowerCase().includes(searchValue)
      );
    });
  }

  res.json({
    success: true,
    count: filteredLeads.length,
    filters: {
      status: status || null,
      service: service || null,
      email: email || null,
      search: search || null
    },
    data: filteredLeads
  });
});

// Get one lead by ID
app.get("/leads/:id", (req, res) => {
  const leadId = Number(req.params.id);

  const lead = leads.find((lead) => lead.id === leadId);

  if (!lead) {
    return res.status(404).json({
      success: false,
      message: "Lead not found"
    });
  }

  res.json({
    success: true,
    data: lead
  });
});

// Get activity logs for one lead
app.get("/leads/:id/logs", (req, res) => {
  const leadId = Number(req.params.id);

  const lead = leads.find((lead) => lead.id === leadId);

  if (!lead) {
    return res.status(404).json({
      success: false,
      message: "Lead not found"
    });
  }

  res.json({
    success: true,
    count: lead.logs ? lead.logs.length : 0,
    data: lead.logs || []
  });
});

// Get email draft for one lead
app.get("/leads/:id/email-draft", (req, res) => {
  const leadId = Number(req.params.id);

  const lead = leads.find((lead) => lead.id === leadId);

  if (!lead) {
    return res.status(404).json({
      success: false,
      message: "Lead not found"
    });
  }

  res.json({
    success: true,
    data: lead.emailDraft
  });
});

// Receive, validate, check duplicate, save, and send new lead to local fake CRM
app.post("/webhook/lead", async (req, res) => {
  const lead = req.body;

  if (!lead.name || !lead.email || !lead.phone || !lead.service) {
    return res.status(400).json({
      success: false,
      message: "Missing required lead data"
    });
  }

  const emailIsValid = lead.email.includes("@");

  if (!emailIsValid) {
    return res.status(400).json({
      success: false,
      message: "Invalid email address",
      status: "Invalid Email"
    });
  }

  const incomingEmail = normalizeEmail(lead.email);

  const existingLead = leads.find((savedLead) => {
    return normalizeEmail(savedLead.email) === incomingEmail;
  });

  if (existingLead) {
    addLog(existingLead, "Duplicate lead blocked", `Duplicate submission detected for email: ${lead.email}`);
    saveLeads();

    return res.status(409).json({
      success: false,
      message: "Lead already exists",
      existingLeadId: existingLead.id,
      data: existingLead
    });
  }

  const processedLead = {
    id: getNextLeadId(),
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    service: lead.service,
    budget: lead.budget || "Not provided",
    bestTimeToContact: lead.bestTimeToContact || "Not provided",
    status: "New Lead",
    firstReplySent: "No",
    summary: "",
    emailDraft: null,
    crmSynced: false,
    crmId: null,
    crmError: null,
    logs: [],
    createdAt: new Date().toISOString()
  };

  addLog(processedLead, "Lead received", "New lead data received from webhook");
  addLog(processedLead, "Lead validated", "Required fields and email format are valid");
  addLog(processedLead, "Duplicate check passed", "No existing lead found with the same email");

  processedLead.summary = generateSummary(processedLead);
  addLog(processedLead, "Summary generated", processedLead.summary);

  processedLead.emailDraft = generateEmailDraft(processedLead);
  addLog(processedLead, "Email draft generated", "Automatic email draft created for the lead");

  addLog(processedLead, "CRM sync attempted", "Trying to send lead to local fake CRM API");

  try {
    const crmResult = await sendLeadToLocalFakeCRM(processedLead);

    processedLead.crmSynced = crmResult.crmSynced;
    processedLead.crmId = crmResult.crmId;
    processedLead.crmError = null;

    addLog(processedLead, "CRM sync successful", `Lead sent to local fake CRM with CRM ID: ${crmResult.crmId}`);
  } catch (error) {
    processedLead.crmSynced = false;
    processedLead.crmError = error.message;

    addLog(processedLead, "CRM sync failed", error.message);
  }

  leads.push(processedLead);
  saveLeads();

  addLog(processedLead, "Lead saved", "Lead saved to leads.json file");
  saveLeads();

  console.log("Valid lead saved and CRM sync attempted:");
  console.log(processedLead);

  res.status(201).json({
    success: true,
    message: "Lead validated, duplicate checked, saved, email draft generated, CRM sync attempted, and logs created",
    data: processedLead
  });
});

// Update lead status
app.put("/leads/:id/status", (req, res) => {
  const leadId = Number(req.params.id);
  const newStatus = req.body.status;

  const lead = leads.find((lead) => lead.id === leadId);

  if (!lead) {
    return res.status(404).json({
      success: false,
      message: "Lead not found"
    });
  }

  if (!newStatus) {
    return res.status(400).json({
      success: false,
      message: "Status is required"
    });
  }

  const oldStatus = lead.status;

  lead.status = newStatus;
  lead.summary = generateSummary(lead);

  addLog(lead, "Status updated", `Status changed from ${oldStatus} to ${newStatus}`);

  saveLeads();

  res.json({
    success: true,
    message: "Lead status updated successfully",
    data: lead
  });
});

// Mark first reply as sent
app.put("/leads/:id/reply-sent", (req, res) => {
  const leadId = Number(req.params.id);

  const lead = leads.find((lead) => lead.id === leadId);

  if (!lead) {
    return res.status(404).json({
      success: false,
      message: "Lead not found"
    });
  }

  lead.firstReplySent = "Yes";
  lead.status = "Replied";
  lead.summary = generateSummary(lead);

  addLog(lead, "First reply sent", "First reply was marked as sent and status changed to Replied");

  saveLeads();

  res.json({
    success: true,
    message: "Lead marked as replied successfully",
    data: lead
  });
});

// Retry CRM sync for one lead
app.post("/leads/:id/retry-crm", async (req, res) => {
  const leadId = Number(req.params.id);

  const lead = leads.find((lead) => lead.id === leadId);

  if (!lead) {
    return res.status(404).json({
      success: false,
      message: "Lead not found"
    });
  }

  if (lead.crmSynced === true) {
    addLog(lead, "CRM retry skipped", "Lead is already synced with CRM");
    saveLeads();

    return res.json({
      success: true,
      message: "Lead is already synced with CRM",
      data: lead
    });
  }

  addLog(lead, "CRM retry attempted", "Trying to sync lead with local fake CRM again");

  try {
    const crmResult = await sendLeadToLocalFakeCRM(lead);

    lead.crmSynced = crmResult.crmSynced;
    lead.crmId = crmResult.crmId;
    lead.crmError = null;

    addLog(lead, "CRM retry successful", `Lead synced with local fake CRM ID: ${crmResult.crmId}`);

    saveLeads();

    res.json({
      success: true,
      message: "CRM retry successful",
      data: lead
    });
  } catch (error) {
    lead.crmSynced = false;
    lead.crmError = error.message;

    addLog(lead, "CRM retry failed", error.message);

    saveLeads();

    res.status(502).json({
      success: false,
      message: "CRM retry failed",
      data: lead
    });
  }
});

// Delete lead by ID
app.delete("/leads/:id", (req, res) => {
  const leadId = Number(req.params.id);

  const leadIndex = leads.findIndex((lead) => lead.id === leadId);

  if (leadIndex === -1) {
    return res.status(404).json({
      success: false,
      message: "Lead not found"
    });
  }

  const lead = leads[leadIndex];

  addLog(lead, "Lead deleted", "Lead was deleted from the system");

  const deletedLead = leads.splice(leadIndex, 1);

  saveLeads();

  res.json({
    success: true,
    message: "Lead deleted successfully",
    data: deletedLead[0]
  });
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
