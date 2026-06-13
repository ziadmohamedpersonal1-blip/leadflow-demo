require("dotenv").config({ override: true });

const express = require("express");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// -------------------- DATABASE SETUP --------------------
const leadsFilePath = path.join(__dirname, "leads.json");

const useSupabase = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
);

const supabase = useSupabase
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  : null;

function loadJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify([], null, 2));
    return [];
  }

  const fileData = fs.readFileSync(filePath, "utf8").trim();

  if (!fileData) {
    return [];
  }

  try {
    const parsed = JSON.parse(fileData);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Invalid local JSON file:", error.message);
    return [];
  }
}

function saveJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

let localLeads = loadJsonFile(leadsFilePath);

async function getAllLeadsFromDb() {
  if (!useSupabase) {
    return localLeads;
  }

  const { data, error } = await supabase
    .from("leads")
    .select("lead")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return (data || []).map((row) => row.lead).filter(Boolean);
}

async function getLeadByIdFromDb(id) {
  if (!useSupabase) {
    return localLeads.find((lead) => Number(lead.id) === Number(id)) || null;
  }

  const { data, error } = await supabase
    .from("leads")
    .select("lead")
    .eq("id", Number(id))
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? data.lead : null;
}

async function getLeadByEmailFromDb(email) {
  const cleanEmail = normalizeEmail(email);

  if (!useSupabase) {
    return localLeads.find((lead) => normalizeEmail(lead.email) === cleanEmail) || null;
  }

  const { data, error } = await supabase
    .from("leads")
    .select("lead")
    .eq("email", cleanEmail)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? data.lead : null;
}

async function getNextLeadIdFromDb() {
  if (!useSupabase) {
    if (localLeads.length === 0) return 1;
    const ids = localLeads.map((lead) => Number(lead.id)).filter((id) => !Number.isNaN(id));
    return ids.length ? Math.max(...ids) + 1 : 1;
  }

  const { data, error } = await supabase
    .from("leads")
    .select("id")
    .order("id", { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(error.message);
  }

  if (!data || data.length === 0) {
    return 1;
  }

  return Number(data[0].id) + 1;
}

async function saveLeadToDb(lead) {
  lead.updatedAt = new Date().toISOString();

  if (!useSupabase) {
    const index = localLeads.findIndex((savedLead) => Number(savedLead.id) === Number(lead.id));

    if (index === -1) {
      localLeads.push(lead);
    } else {
      localLeads[index] = lead;
    }

    saveJsonFile(leadsFilePath, localLeads);
    return lead;
  }

  const { error } = await supabase.from("leads").upsert(
    {
      id: Number(lead.id),
      email: normalizeEmail(lead.email),
      lead,
      updated_at: new Date().toISOString(),
    },
    {
      onConflict: "id",
    }
  );

  if (error) {
    throw new Error(error.message);
  }

  return lead;
}

async function deleteLeadFromDb(id) {
  if (!useSupabase) {
    const index = localLeads.findIndex((lead) => Number(lead.id) === Number(id));

    if (index === -1) {
      return null;
    }

    const deleted = localLeads.splice(index, 1)[0];
    saveJsonFile(leadsFilePath, localLeads);
    return deleted;
  }

  const lead = await getLeadByIdFromDb(id);

  if (!lead) {
    return null;
  }

  const { error } = await supabase.from("leads").delete().eq("id", Number(id));

  if (error) {
    throw new Error(error.message);
  }

  return lead;
}

// -------------------- EMAIL SETUP --------------------
const emailTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// -------------------- HELPERS --------------------
function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeEmail(email) {
  return normalizeText(email).toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function addLog(lead, action, details) {
  if (!lead.logs) {
    lead.logs = [];
  }

  lead.logs.push({
    action,
    details: details || "",
    createdAt: new Date().toISOString(),
  });
}

function generateSummary(lead) {
  return `${lead.name} requested ${lead.service}. Phone: ${lead.phone}. Status: ${lead.status}.`;
}

function calculateLeadScore(lead) {
  let score = 0;

  if (lead.email) score += 20;
  if (lead.phone) score += 20;
  if (lead.service && lead.service !== "Not provided") score += 20;
  if (lead.budget && lead.budget !== "Not provided") score += 20;
  if (lead.bestTimeToContact && lead.bestTimeToContact !== "Not provided") score += 20;

  let category = "Cold";

  if (score >= 80) {
    category = "Hot";
  } else if (score >= 50) {
    category = "Warm";
  }

  return { score, category };
}

function generateEmailDraft(lead) {
  return {
    to: lead.email,
    subject: "We received your request",
    body: `Hi ${lead.name},

Thanks for contacting us about ${lead.service}.

We received your request and our team will contact you soon.

Best,
LeadFlow Team`,
  };
}

function splitFullName(fullName) {
  const cleanName = normalizeText(fullName);

  if (!cleanName) {
    return {
      firstname: "Unknown",
      lastname: "",
    };
  }

  const nameParts = cleanName.split(" ").filter(Boolean);

  return {
    firstname: nameParts[0] || cleanName,
    lastname: nameParts.slice(1).join(" "),
  };
}

function filterLeads(leads, query) {
  const status = normalizeText(query.status);
  const service = normalizeText(query.service);
  const email = normalizeEmail(query.email);
  const search = normalizeText(query.search).toLowerCase();

  let filteredLeads = [...leads];

  if (status) {
    filteredLeads = filteredLeads.filter((lead) => {
      return normalizeText(lead.status).toLowerCase() === status.toLowerCase();
    });
  }

  if (service) {
    filteredLeads = filteredLeads.filter((lead) => {
      return normalizeText(lead.service).toLowerCase() === service.toLowerCase();
    });
  }

  if (email) {
    filteredLeads = filteredLeads.filter((lead) => {
      return normalizeEmail(lead.email) === email;
    });
  }

  if (search) {
    filteredLeads = filteredLeads.filter((lead) => {
      return (
        normalizeText(lead.name).toLowerCase().includes(search) ||
        normalizeText(lead.email).toLowerCase().includes(search) ||
        normalizeText(lead.phone).toLowerCase().includes(search) ||
        normalizeText(lead.service).toLowerCase().includes(search)
      );
    });
  }

  return filteredLeads;
}

function csvEscape(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return `"${String(value).replaceAll('"', '""')}"`;
}

function buildCsv(leads) {
  const headers = [
    "ID",
    "Name",
    "Email",
    "Phone",
    "Service",
    "Budget",
    "Best Time To Contact",
    "Status",
    "First Reply Sent",
    "Email Sent",
    "Email Sent At",
    "CRM Synced",
    "CRM ID",
    "Created At",
  ];

  const rows = leads.map((lead) => [
    lead.id,
    lead.name,
    lead.email,
    lead.phone,
    lead.service,
    lead.budget,
    lead.bestTimeToContact,
    lead.status,
    lead.firstReplySent,
    lead.emailSent ? "Yes" : "No",
    lead.emailSentAt || "",
    lead.crmSynced ? "Yes" : "No",
    lead.crmId || "",
    lead.createdAt,
  ]);

  return [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
}

// -------------------- HUBSPOT CRM --------------------
async function findHubSpotContactByEmail(email) {
  const response = await axios.post(
    "https://api.hubapi.com/crm/v3/objects/contacts/search",
    {
      filterGroups: [
        {
          filters: [
            {
              propertyName: "email",
              operator: "EQ",
              value: normalizeEmail(email),
            },
          ],
        },
      ],
      properties: ["email", "firstname", "lastname", "phone"],
      limit: 1,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (response.data.results && response.data.results.length > 0) {
    return response.data.results[0];
  }

  return null;
}

async function sendLeadToHubSpotCRM(lead) {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    throw new Error("Missing HUBSPOT_ACCESS_TOKEN in environment variables");
  }

  const name = splitFullName(lead.name);

  const hubspotProperties = {
    email: normalizeEmail(lead.email),
    firstname: name.firstname,
    lastname: name.lastname,
    phone: lead.phone || "",
    lifecyclestage: "lead",
  };

  const existingContact = await findHubSpotContactByEmail(lead.email);

  if (existingContact) {
    const updateResponse = await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${existingContact.id}`,
      { properties: hubspotProperties },
      {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    return {
      crmSynced: true,
      crmId: updateResponse.data.id,
      crmProvider: "HubSpot",
      crmAction: "updated",
      crmResponse: updateResponse.data,
    };
  }

  const createResponse = await axios.post(
    "https://api.hubapi.com/crm/v3/objects/contacts",
    { properties: hubspotProperties },
    {
      headers: {
        Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  return {
    crmSynced: true,
    crmId: createResponse.data.id,
    crmProvider: "HubSpot",
    crmAction: "created",
    crmResponse: createResponse.data,
  };
}

// -------------------- ROUTES --------------------
app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "OK",
    database: useSupabase ? "Supabase" : "Local JSON fallback",
    message: "LeadFlow server is running",
  });
});

app.get("/dashboard", async (req, res) => {
  try {
    const leads = await getAllLeadsFromDb();

    const totalLeads = leads.length;
    const newLeads = leads.filter((lead) => lead.status === "New Lead").length;
    const repliedLeads = leads.filter((lead) => lead.status === "Replied").length;
    const crmSyncedLeads = leads.filter((lead) => lead.crmSynced === true).length;
    const crmFailedLeads = leads.filter((lead) => lead.crmSynced === false).length;

    const duplicateBlocked = leads.reduce((total, lead) => {
      const duplicateLogs = (lead.logs || []).filter((log) => log.action === "Duplicate lead blocked");
      return total + duplicateLogs.length;
    }, 0);

    const leadsByService = {};

    leads.forEach((lead) => {
      const service = lead.service || "Not provided";
      leadsByService[service] = (leadsByService[service] || 0) + 1;
    });

    const latestLeads = [...leads]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 5);

    res.json({
      success: true,
      data: {
        totalLeads,
        newLeads,
        repliedLeads,
        crmSyncedLeads,
        crmFailedLeads,
        duplicateBlocked,
        leadsByService,
        latestLeads,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load dashboard",
      error: error.message,
    });
  }
});

app.get("/leads", async (req, res) => {
  try {
    const leads = await getAllLeadsFromDb();
    const filteredLeads = filterLeads(leads, req.query);

    res.json({
      success: true,
      count: filteredLeads.length,
      filters: {
        status: req.query.status || null,
        service: req.query.service || null,
        email: req.query.email || null,
        search: req.query.search || null,
      },
      data: filteredLeads,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load leads",
      error: error.message,
    });
  }
});

app.get("/leads/:id", async (req, res) => {
  try {
    const lead = await getLeadByIdFromDb(req.params.id);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    res.json({
      success: true,
      data: lead,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load lead",
      error: error.message,
    });
  }
});

app.get("/leads/:id/logs", async (req, res) => {
  try {
    const lead = await getLeadByIdFromDb(req.params.id);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    res.json({
      success: true,
      count: lead.logs ? lead.logs.length : 0,
      data: lead.logs || [],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load logs",
      error: error.message,
    });
  }
});

app.get("/leads/:id/email-draft", async (req, res) => {
  try {
    const lead = await getLeadByIdFromDb(req.params.id);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    res.json({
      success: true,
      data: lead.emailDraft,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load email draft",
      error: error.message,
    });
  }
});

app.post("/webhook/lead", async (req, res) => {
  try {
    const incomingLead = req.body;

    if (!incomingLead.name || !incomingLead.email || !incomingLead.phone || !incomingLead.service) {
      return res.status(400).json({
        success: false,
        message: "Missing required lead data",
      });
    }

    if (!isValidEmail(incomingLead.email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email address",
        status: "Invalid Email",
      });
    }

    const existingLead = await getLeadByEmailFromDb(incomingLead.email);

    if (existingLead) {
      addLog(existingLead, "Duplicate lead blocked", `Duplicate submission detected for email: ${incomingLead.email}`);
      await saveLeadToDb(existingLead);

      return res.status(409).json({
        success: false,
        message: "Lead already exists",
        existingLeadId: existingLead.id,
        data: existingLead,
      });
    }

    const processedLead = {
      id: await getNextLeadIdFromDb(),
      name: normalizeText(incomingLead.name),
      email: normalizeEmail(incomingLead.email),
      phone: normalizeText(incomingLead.phone),
      service: normalizeText(incomingLead.service),
      budget: normalizeText(incomingLead.budget) || "Not provided",
      bestTimeToContact: normalizeText(incomingLead.bestTimeToContact) || "Not provided",
      notes: normalizeText(incomingLead.notes) || "Not provided",
      status: "New Lead",
      firstReplySent: "No",
      summary: "",
      emailDraft: null,
      leadScore: 0,
      leadScoreCategory: "Cold",
      crmSynced: false,
      crmId: null,
      crmProvider: "HubSpot",
      crmAction: null,
      crmError: null,
      emailSent: false,
      emailSentAt: null,
      logs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    addLog(processedLead, "Lead received", "New lead data received from webhook");
    addLog(processedLead, "Lead validated", "Required fields and email format are valid");
    addLog(processedLead, "Duplicate check passed", "No existing lead found with the same email");

    const score = calculateLeadScore(processedLead);
    processedLead.leadScore = score.score;
    processedLead.leadScoreCategory = score.category;
    addLog(processedLead, "Lead scored", `${score.category} lead with score ${score.score}/100`);

    processedLead.summary = generateSummary(processedLead);
    addLog(processedLead, "Summary generated", processedLead.summary);

    processedLead.emailDraft = generateEmailDraft(processedLead);
    addLog(processedLead, "Email draft generated", "Automatic email draft created for the lead");

    addLog(processedLead, "CRM sync attempted", "Trying to send lead to HubSpot CRM");

    try {
      const crmResult = await sendLeadToHubSpotCRM(processedLead);

      processedLead.crmSynced = crmResult.crmSynced;
      processedLead.crmId = crmResult.crmId;
      processedLead.crmProvider = crmResult.crmProvider;
      processedLead.crmAction = crmResult.crmAction;
      processedLead.crmError = null;

      addLog(processedLead, "CRM sync successful", `Lead sent to HubSpot CRM with CRM ID: ${crmResult.crmId}`);
    } catch (error) {
      processedLead.crmSynced = false;
      processedLead.crmError = error.message;
      addLog(processedLead, "CRM sync failed", error.message);
    }

    await saveLeadToDb(processedLead);
    addLog(processedLead, "Lead saved", useSupabase ? "Lead saved to Supabase database" : "Lead saved to local leads.json file");
    await saveLeadToDb(processedLead);

    res.status(201).json({
      success: true,
      message: "Lead validated, duplicate checked, saved, email draft generated, CRM sync attempted, and logs created",
      data: processedLead,
    });
  } catch (error) {
    console.error("Create lead error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to create lead",
      error: error.message,
    });
  }
});

app.put("/leads/:id/status", async (req, res) => {
  try {
    const lead = await getLeadByIdFromDb(req.params.id);
    const newStatus = normalizeText(req.body.status);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    if (!newStatus) {
      return res.status(400).json({
        success: false,
        message: "Status is required",
      });
    }

    const oldStatus = lead.status;

    lead.status = newStatus;
    lead.summary = generateSummary(lead);
    addLog(lead, "Status updated", `Status changed from ${oldStatus} to ${newStatus}`);

    await saveLeadToDb(lead);

    res.json({
      success: true,
      message: "Lead status updated successfully",
      data: lead,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to update status",
      error: error.message,
    });
  }
});

app.put("/leads/:id/reply-sent", async (req, res) => {
  try {
    const lead = await getLeadByIdFromDb(req.params.id);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    lead.firstReplySent = "Yes";
    lead.status = "Replied";
    lead.summary = generateSummary(lead);

    addLog(lead, "First reply sent", "First reply was marked as sent and status changed to Replied");

    await saveLeadToDb(lead);

    res.json({
      success: true,
      message: "Lead marked as replied successfully",
      data: lead,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to mark reply as sent",
      error: error.message,
    });
  }
});

app.post("/leads/:id/send-email", async (req, res) => {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      return res.status(500).json({
        success: false,
        message: "Email credentials are missing. Check environment variables.",
      });
    }

    const lead = await getLeadByIdFromDb(req.params.id);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    if (!lead.email) {
      return res.status(400).json({
        success: false,
        message: "Lead has no email address",
      });
    }

    let emailSubject = `Thanks ${lead.name || "there"} — we received your request`;
    let emailBody = "";

    if (typeof lead.emailDraft === "string") {
      emailBody = lead.emailDraft;
    } else if (lead.emailDraft && typeof lead.emailDraft === "object") {
      emailSubject = lead.emailDraft.subject || lead.emailDraft.emailSubject || emailSubject;
      emailBody = lead.emailDraft.body || lead.emailDraft.text || lead.emailDraft.message || JSON.stringify(lead.emailDraft, null, 2);
    } else {
      emailBody = `Hi ${lead.name || "there"},

Thanks for reaching out.

We received your request and our team will review it shortly.

Best regards,
LeadFlow Team`;
    }

    await emailTransporter.sendMail({
      from: `"LeadFlow Command Center" <${process.env.EMAIL_USER}>`,
      to: lead.email,
      subject: String(emailSubject),
      text: String(emailBody),
    });

    lead.emailSent = true;
    lead.emailSentAt = new Date().toISOString();
    lead.firstReplySent = "Yes";
    lead.status = "Replied";
    lead.summary = generateSummary(lead);

    addLog(lead, "Email sent to lead", `Real email sent to ${lead.email}`);

    await saveLeadToDb(lead);

    res.json({
      success: true,
      message: "Email sent successfully",
      data: lead,
    });
  } catch (error) {
    console.error("Send email error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to send email",
      error: error.message,
    });
  }
});

app.post("/leads/:id/retry-crm", async (req, res) => {
  try {
    const lead = await getLeadByIdFromDb(req.params.id);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    if (lead.crmSynced === true) {
      addLog(lead, "CRM retry skipped", "Lead is already synced with CRM");
      await saveLeadToDb(lead);

      return res.json({
        success: true,
        message: "Lead is already synced with CRM",
        data: lead,
      });
    }

    addLog(lead, "CRM retry attempted", "Trying to sync lead with HubSpot CRM again");

    const crmResult = await sendLeadToHubSpotCRM(lead);

    lead.crmSynced = crmResult.crmSynced;
    lead.crmId = crmResult.crmId;
    lead.crmProvider = crmResult.crmProvider;
    lead.crmAction = crmResult.crmAction;
    lead.crmError = null;

    addLog(lead, "CRM retry successful", `Lead synced with HubSpot CRM ID: ${crmResult.crmId}`);

    await saveLeadToDb(lead);

    res.json({
      success: true,
      message: "CRM retry successful",
      data: lead,
    });
  } catch (error) {
    try {
      const lead = await getLeadByIdFromDb(req.params.id);

      if (lead) {
        lead.crmSynced = false;
        lead.crmError = error.message;
        addLog(lead, "CRM retry failed", error.message);
        await saveLeadToDb(lead);

        return res.status(502).json({
          success: false,
          message: "CRM retry failed",
          data: lead,
        });
      }
    } catch (innerError) {
      console.error("CRM retry save error:", innerError);
    }

    res.status(502).json({
      success: false,
      message: "CRM retry failed",
      error: error.message,
    });
  }
});

app.delete("/leads/:id", async (req, res) => {
  try {
    const lead = await getLeadByIdFromDb(req.params.id);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    addLog(lead, "Lead deleted", "Lead was deleted from the system");
    await saveLeadToDb(lead);

    const deletedLead = await deleteLeadFromDb(req.params.id);

    res.json({
      success: true,
      message: "Lead deleted successfully",
      data: deletedLead,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete lead",
      error: error.message,
    });
  }
});

app.get("/export/csv", async (req, res) => {
  try {
    const leads = await getAllLeadsFromDb();
    const csv = buildCsv(leads);

    res.setHeader("Content-Type", "text/csv;charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="leadflow-leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to export CSV",
      error: error.message,
    });
  }
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`LeadFlow server running on port ${PORT}`);
    console.log(`Database mode: ${useSupabase ? "Supabase" : "Local JSON fallback"}`);
  });
}

module.exports = app;