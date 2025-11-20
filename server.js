// server.js — LM-only (/api/chat) + RAG (/api/rag-chat)
// Project QA deterministic จาก kb/projects/*.txt + Profile/FAQ

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const glob = require("glob");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
const LM_BASE_URL = process.env.LM_BASE_URL || "http://127.0.0.1:1234";
const LM_MODEL = process.env.LM_MODEL || "typhoon2.5-qwen3-4b-i1";
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "60000", 10);

// ===== KB paths =====
const KB_DIR = process.env.KB_DIR || "kb";
const PROFILE_FILE = path.join(KB_DIR, "profile_pond.txt");
const FAQ_FILE = path.join(KB_DIR, "faq.txt");
const PROJECT_DIR = path.join(KB_DIR, "projects");

// ===== Utils =====
const isTextFile = (f) => /\.(md|txt|json)$/i.test(f);

function normalizeSimple(s = "") {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9ก-๙\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const safeRead = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

// ======================================================
//   PROFILE ANSWER (deterministic)
// ======================================================
function readProfileFull() {
  try {
    if (!fs.existsSync(PROFILE_FILE)) return null;
    const t = fs.readFileSync(PROFILE_FILE, "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

function readProfileNameOnly() {
  const full = readProfileFull();
  if (!full) return null;
  const line = full.split(/\r?\n/).find((l) => /^ชื่อ\s*:/i.test(l.trim()));
  return line ? line.replace(/^ชื่อ\s*:\s*/i, "").trim() : full;
}

function isAskWhoAboutWan(raw) {
  const rawL = (raw || "").toLowerCase();
  const n = normalizeSimple(raw);
  const reRaw = /(ใครคือ|คือใคร).*(วรรณวรินทร์)(\s*รักญาติ)?/i;
  if (reRaw.test(rawL)) return true;

  return (
    (n.includes("ใครคือ") || n.includes("คือใคร")) &&
    (n.includes("วรรณวรินทร์") || n.includes("วรรณวรินทร์รักญาติ"))
  );
}

function tryProfileAnswer(raw) {
  const n = normalizeSimple(raw).replace(/\s+/g, "");
  if (n === "ฉันคือใคร") return readProfileNameOnly();
  if (isAskWhoAboutWan(raw)) return readProfileFull();
  return null;
}

// ======================================================
//   FAQ DETERMINISTIC
// ======================================================
let FAQ_CACHE = null;

function loadFAQ() {
  const raw = safeRead(FAQ_FILE);
  const lines = raw.split(/\r?\n/);

  const items = [];
  let curQ = "",
    curA = "";

  const flush = () => {
    if (curQ && curA) {
      items.push({
        qRaw: curQ.trim(),
        qNorm: normalizeSimple(curQ),
        aRaw: curA.trim(),
      });
    }
    curQ = "";
    curA = "";
  };

  for (const line of lines) {
    if (/^\s*Q\s*:/i.test(line)) {
      flush();
      curQ = line.replace(/^\s*Q\s*:\s*/i, "");
    } else if (/^\s*A\s*:/i.test(line)) {
      curA = line.replace(/^\s*A\s*:\s*/i, "");
    } else if (curA) {
      curA += "\n" + line;
    }
  }
  flush();

  FAQ_CACHE = items;
}

function ensureFAQ() {
  if (FAQ_CACHE === null) loadFAQ();
}

function jaccard(a, b) {
  const sa = new Set(normalizeSimple(a).split(" ").filter(Boolean));
  const sb = new Set(normalizeSimple(b).split(" ").filter(Boolean));
  if (!sa.size || !sb.size) return 0;

  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;

  return inter / (sa.size + sb.size - inter);
}

function tryFAQAnswer(question) {
  ensureFAQ();
  if (!FAQ_CACHE?.length) return null;

  const qNorm = normalizeSimple(question);

  for (const it of FAQ_CACHE) {
    if (
      qNorm === it.qNorm ||
      qNorm.includes(it.qNorm) ||
      it.qNorm.includes(qNorm)
    )
      return it.aRaw;
  }

  let best = null,
    bestScore = 0;
  for (const it of FAQ_CACHE) {
    const sc = jaccard(qNorm, it.qNorm);
    if (sc > bestScore) {
      bestScore = sc;
      best = it;
    }
  }
  if (best && bestScore >= 0.5) return best.aRaw;

  return null;
}

// ======================================================
//   PROJECT KB (deterministic) + fuzzy access
// ======================================================
let PROJECTS_CACHE = null;
let PROJECT_LIST = [];

function loadProjects() {
  const map = {};
  const arr = [];

  if (!fs.existsSync(PROJECT_DIR)) return { map: {}, list: [] };

  let fileNames = fs
    .readdirSync(PROJECT_DIR)
    .filter((f) => f.toLowerCase().endsWith(".txt"))
    .sort();

  fileNames.forEach((name, idx) => {
    const full = path.join(PROJECT_DIR, name);
    const raw = safeRead(full);
    if (!raw) return;

    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const proj = { raw, file: name, index: idx + 1 };

    for (const line of lines) {
      const parts = line.split(/\s*-\s*/);
      if (parts.length < 2) continue;
      const key = parts[0].trim();
      const val = parts.slice(1).join(" - ").trim();

      if (/^รหัสโครงการ/i.test(key)) {
        let code = val.toUpperCase().replace(/\s+/g, "");
        const m = code.match(/PRJ-?(\d{3})/);
        if (m) code = `PRJ-${m[1]}`;
        proj.code = code;
      } else if (/^ชื่อโครงการ/i.test(key)) {
        proj.name = val;
      } else if (/^มูลค่า/i.test(key)) {
        proj.budget = val;
      } else if (/^วันที่เริ่มต้น/i.test(key)) {
        proj.start_date = val;
      } else if (/^วันที่สิ้นสุด/i.test(key)) {
        proj.end_date = val;
      } else if (/^ระยะเวลา/i.test(key)) {
        proj.duration = val;
      } else if (/^ผู้รับผิดชอบ/i.test(key)) {
        proj.owner = val;
      }
    }

    if (proj.code) {
      const allText = [
        proj.code,
        proj.name,
        proj.budget,
        proj.start_date,
        proj.end_date,
        proj.duration,
        proj.owner,
      ]
        .filter(Boolean)
        .join(" ");

      proj._normText = normalizeSimple(allText);
      proj._nameNorm = proj.name ? normalizeSimple(proj.name) : "";
      map[proj.code] = proj;
      arr.push(proj);
    }
  });

  return { map, list: arr };
}

function ensureProjects() {
  const { map, list } = loadProjects();
  PROJECTS_CACHE = map;
  PROJECT_LIST = list;
}

// ---------- ฟีเจอร์พิเศษ: งบมากสุด / งบน้อยสุด / เริ่มเร็วสุด / เริ่มช้าที่สุด ----------
function tryProjectQuerySpecial(message) {
  const lower = message.toLowerCase();

  const parseBudget = (x) =>
    parseInt((x || "0").replace(/[^0-9]/g, ""), 10) || 0;

  const parseDate = (d) => {
    if (!d) return null;
    const [day, month, year] = d.split(/[\/\-]/).map(Number);
    if (!day || !month || !year) return null;
    return new Date(year, month - 1, day);
  };

  // งบมากที่สุด
  if (
    lower.includes("งบมากที่สุด") ||
    lower.includes("งบสูงสุด") ||
    lower.includes("ราคาแพงสุด") ||
    lower.includes("แพงที่สุด")
  ) {
    let best = null;
    let bestVal = 0;

    for (const p of PROJECT_LIST) {
      const val = parseBudget(p.budget);
      if (val > bestVal) {
        bestVal = val;
        best = p;
      }
    }

    if (!best) return null;
    return `โครงการที่มีงบประมาณสูงที่สุดคือ:\n\n${formatProjectFull(best)}`;
  }

  // งบน้อยที่สุด
  if (
    lower.includes("งบน้อยที่สุด") ||
    lower.includes("งบต่ำสุด") ||
    lower.includes("ถูกที่สุด") ||
    lower.includes("ราคาถูกสุด")
  ) {
    let best = null;
    let bestVal = Infinity;

    for (const p of PROJECT_LIST) {
      const val = parseBudget(p.budget);
      if (val > 0 && val < bestVal) {
        bestVal = val;
        best = p;
      }
    }

    if (!best || !isFinite(bestVal)) return null;
    return `โครงการที่มีงบประมาณน้อยที่สุดคือ:\n\n${formatProjectFull(best)}`;
  }

  // เริ่มเร็วที่สุด
  if (
    lower.includes("เริ่มเร็วที่สุด") ||
    lower.includes("เริ่มก่อน") ||
    lower.includes("เริ่มไวที่สุด")
  ) {
    let best = null;
    let earliest = null;

    for (const p of PROJECT_LIST) {
      const dt = parseDate(p.start_date);
      if (!dt) continue;
      if (!earliest || dt < earliest) {
        earliest = dt;
        best = p;
      }
    }

    if (!best) return null;
    return `โครงการที่เริ่มต้นเร็วที่สุดคือ:\n\n${formatProjectFull(best)}`;
  }

  // เริ่มช้าที่สุด
  if (
    lower.includes("เริ่มช้าที่สุด") ||
    lower.includes("เริ่มช้าสุด") ||
    lower.includes("เริ่มหลังสุด") ||
    lower.includes("เริ่มทีหลัง")
  ) {
    let best = null;
    let latest = null;

    for (const p of PROJECT_LIST) {
      const dt = parseDate(p.start_date);
      if (!dt) continue;
      if (!latest || dt > latest) {
        latest = dt;
        best = p;
      }
    }

    if (!best) return null;
    return `โครงการที่เริ่มต้นช้าที่สุดคือ:\n\n${formatProjectFull(best)}`;
  }

  return null;
}

// ---------- helper หารหัส / index ----------
function extractProjectCode(message) {
  const upper = (message || "").toUpperCase();
  const m = upper.match(/PRJ[\s\-]?(\d{3})/);
  return m ? `PRJ-${m[1]}` : null;
}

function extractProjectIndex(message) {
  const m = (message || "").match(/(ไฟล์ที่|โครงการที่)\s*(\d{1,3})/);
  return m ? parseInt(m[2], 10) : null;
}

// ---------- หาโปรเจกต์จากข้อความ ----------
function findProjectByMessage(message) {
  if (!PROJECTS_CACHE) ensureProjects();
  const msg = message || "";
  const msgNorm = normalizeSimple(msg);
  if (!msgNorm) return null;

  // 1) index เช่น "ไฟล์ที่ 1" / "โครงการที่ 2"
  const idx = extractProjectIndex(msg);
  if (idx && PROJECT_LIST[idx - 1]) return PROJECT_LIST[idx - 1];

  // 2) รหัส PRJ-xxx
  const code = extractProjectCode(msg);
  if (code && PROJECTS_CACHE[code]) return PROJECTS_CACHE[code];

  // 3) ตรงชื่อโครงการแบบ substring ก่อน
  for (const proj of PROJECT_LIST) {
    if (!proj._nameNorm) continue;
    if (msgNorm.includes(proj._nameNorm) || proj._nameNorm.includes(msgNorm)) {
      return proj;
    }
  }

  // 4) fuzzy เทียบกับข้อความรวมในไฟล์
  let best = null;
  let bestScore = 0;

  for (const proj of PROJECT_LIST) {
    if (!proj._normText) continue;
    const sc = jaccard(msgNorm, proj._normText);
    if (sc > bestScore) {
      bestScore = sc;
      best = proj;
    }
  }

  return bestScore >= 0.12 ? best : null;
}

// ---------- format & field detection ----------
function formatProjectFull(proj) {
  return [
    `รหัสโครงการ - ${proj.code || "-"}`,
    `ชื่อโครงการ - ${proj.name || "-"}`,
    `มูลค่าโครงการ (บาท) - ${proj.budget || "-"}`,
    `วันที่เริ่มต้น - ${proj.start_date || "-"}`,
    `วันที่สิ้นสุด - ${proj.end_date || "-"}`,
    `ระยะเวลา (วัน) - ${proj.duration || "-"}`,
    `ผู้รับผิดชอบ - ${proj.owner || "-"}`,
  ].join("\n");
}

function getRequestedFields(lowerMsg) {
  const lower = lowerMsg.toLowerCase();

  const wantCode =
    lower.includes("รหัสโครงการ") ||
    lower.includes("project code") ||
    lower.includes("โค้ด");

  const wantName =
    lower.includes("ชื่อโครงการ") ||
    (lower.includes("ชื่อ") && lower.includes("โครงการ")) ||
    lower.includes("project name");

  const wantBudget =
    lower.includes("มูลค่า") ||
    lower.includes("งบประมาณ") ||
    lower.includes("งบ") ||
    lower.includes("budget") ||
    lower.includes("ราคา");

  const wantStart =
    lower.includes("วันที่เริ่มต้น") ||
    lower.includes("วันเริ่มต้น") ||
    lower.includes("วันเริ่ม") ||
    lower.includes("เริ่มเมื่อไหร่") ||
    lower.includes("เริ่มวันไหน");

  const wantEnd =
    lower.includes("วันที่สิ้นสุด") ||
    lower.includes("วันสิ้นสุด") ||
    lower.includes("วันจบ") ||
    lower.includes("สิ้นสุดเมื่อไหร่");

  const wantDuration =
    lower.includes("ระยะเวลา") ||
    lower.includes("ใช้เวลากี่วัน") ||
    lower.includes("กี่วัน");

  const wantOwner =
    lower.includes("ผู้รับผิดชอบ") ||
    lower.includes("เจ้าของโครงการ") ||
    lower.includes("คนดูแล") ||
    lower.includes("ผู้ดูแล");

  const wantAll =
    lower.includes("มีข้อมูลอะไรบ้าง") ||
    lower.includes("ข้อมูลอะไรบ้าง") ||
    lower.includes("รายละเอียดอะไรบ้าง") ||
    lower.includes("รายละเอียด") ||
    lower.includes("ข้อมูลทั้งหมด") ||
    lower.includes("ข้อมูลโครงการ");

  return {
    wantCode,
    wantName,
    wantBudget,
    wantStart,
    wantEnd,
    wantDuration,
    wantOwner,
    wantAll,
  };
}

function tryProjectAnswer(message) {
  const msg = message || "";
  if (!msg.trim()) return null;
  if (!PROJECTS_CACHE) ensureProjects();

  // 0) คำถามพิเศษ
  const special = tryProjectQuerySpecial(msg);
  if (special) return special;

  const proj = findProjectByMessage(msg);
  if (!proj) return null;

  const fields = getRequestedFields(msg.toLowerCase());
  const code = proj.code;

  const anySpecific =
    fields.wantCode ||
    fields.wantName ||
    fields.wantBudget ||
    fields.wantStart ||
    fields.wantEnd ||
    fields.wantDuration ||
    fields.wantOwner;

  if (fields.wantAll || !anySpecific) {
    return formatProjectFull(proj);
  }

  if (fields.wantCode) return `รหัสโครงการของโครงการนี้คือ ${code}`;
  if (fields.wantName) return `ชื่อโครงการ ${code} คือ ${proj.name || "-"}`;
  if (fields.wantBudget)
    return `มูลค่าโครงการ ${code} คือ ${proj.budget || "ไม่ทราบ"} บาท`;
  if (fields.wantStart)
    return `วันที่เริ่มต้นของโครงการ ${code} คือ ${proj.start_date || "ไม่ทราบ"}`;
  if (fields.wantEnd)
    return `วันที่สิ้นสุดของโครงการ ${code} คือ ${proj.end_date || "ไม่ทราบ"}`;
  if (fields.wantDuration)
    return `ระยะเวลาโครงการ ${code} คือ ${proj.duration || "ไม่ทราบ"} วัน`;
  if (fields.wantOwner)
    return `ผู้รับผิดชอบโครงการ ${code} คือ ${proj.owner || "ไม่ระบุ"}`;

  return formatProjectFull(proj);
}

// ======================================================
//   RAG — ทั่วไป
// ======================================================
function chunkText(text, size = 900, overlap = 150) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + size, text.length);
    out.push(text.slice(i, end));
    if (end === text.length) break;
    i = Math.max(0, end - overlap);
  }
  return out;
}

function tokenize(s = "") {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9ก-๙\s]/gi, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function score(query, passage) {
  const q = tokenize(query);
  const p = tokenize(passage);
  if (!q.length || !p.length) return 0;

  const bag = new Map();
  for (const w of p) bag.set(w, (bag.get(w) || 0) + 1);

  let s = 0;
  for (const w of q) {
    const f = bag.get(w) || 0;
    if (f > 0) s += 1 + Math.min(2, (w.length - 3) * 0.1);
  }

  return s / Math.sqrt(p.length);
}

function loadKBDocs() {
  if (!fs.existsSync(KB_DIR)) return [];
  const allFiles = glob.sync(path.join(KB_DIR, "**/*"), { nodir: true });
  const docs = [];

  for (const full of allFiles) {
    if (!isTextFile(full)) continue;
    const raw = safeRead(full);
    if (!raw) continue;

    const fName = path.basename(full);
    let text = raw;

    if (/\.json$/i.test(full)) {
      try {
        text = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {}
    }

    const chunks = chunkText(text);
    chunks.forEach((c, idx) => {
      docs.push({
        id: `${fName}#${idx + 1}`,
        file: fName,
        text: c.trim(),
      });
    });
  }
  return docs;
}

function retrieveTopK(query, k = 4) {
  const docs = loadKBDocs();
  if (!docs.length) return [];

  return docs
    .map((d) => {
      let sc = score(query, d.text);
      const fn = d.file.toLowerCase();
      if (fn.includes("faq")) sc *= 1.3;
      if (fn.includes("company")) sc *= 1.2;
      if (fn.includes("profile")) sc *= 1.1;
      if (fn.includes("prj")) sc *= 1.1;
      return { ...d, _score: sc };
    })
    .filter((d) => d._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, k);
}

function buildContext(query, topK = 4) {
  const hits = retrieveTopK(query, topK);
  if (!hits.length) return "";
  return hits
    .map((h, i) => `【${i + 1} • ${h.file}】\n${h.text}`)
    .join("\n\n");
}

// ======================================================
//   /api/chat
// ======================================================
app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body || {};

  if (!message || typeof message !== "string")
    return res.status(400).json({ error: "Missing 'message'" });

  const pAns = tryProfileAnswer(message);
  if (pAns) return res.json({ reply: pAns, answered_from: "profile" });

  const projAns = tryProjectAnswer(message);
  if (projAns) return res.json({ reply: projAns, answered_from: "project" });

  const msgs = [
    {
      role: "system",
      content:
        "ตอบสั้น กระชับ ตรงคำถาม เป็นภาษาไทย หากไม่แน่ใจให้ตอบว่า 'ไม่ทราบ' ห้ามเดา",
    },
    ...history,
    { role: "user", content: message },
  ];

  try {
    const resp = await axios.post(
      `${LM_BASE_URL}/v1/chat/completions`,
      { model: LM_MODEL, messages: msgs, temperature: 0.2, max_tokens: 512 },
      { timeout: TIMEOUT_MS }
    );

    const reply =
      resp?.data?.choices?.[0]?.message?.content?.trim() || "ไม่ทราบ";
    res.json({ reply, answered_from: "lm_only" });
  } catch (err) {
    console.error("LM error:", err?.response?.data || err.message);
    res.status(500).json({ error: "LM request failed" });
  }
});

// ======================================================
//   /api/rag-chat
// ======================================================
app.post("/api/rag-chat", async (req, res) => {
  const { message, history = [], top_k = 4 } = req.body || {};

  if (!message)
    return res.status(400).json({ error: "Missing 'message'" });

  const pAns = tryProfileAnswer(message);
  if (pAns) return res.json({ reply: pAns, answered_from: "profile" });

  const projAns = tryProjectAnswer(message);
  if (projAns) return res.json({ reply: projAns, answered_from: "project" });

  const faqAns = tryFAQAnswer(message);
  if (faqAns) return res.json({ reply: faqAns, answered_from: "faq" });

  const context = buildContext(
    message,
    Math.min(8, Math.max(1, Number(top_k) || 4))
  );

  if (!context) {
    return res.json({ reply: "ไม่ทราบ", used_context: false });
  }

  const systemPrompt =
    "คุณคือผู้ช่วยที่ตอบสั้น กระชับ และตรงประเด็นเป็นภาษาไทย " +
    "ให้ใช้ข้อมูลจาก CONTEXT เท่านั้น หากไม่มีข้อมูลให้ตอบว่า 'ไม่ทราบ' ห้ามเดา";

  const msgs = [
    { role: "system", content: systemPrompt },
    { role: "system", content: "CONTEXT:\n" + context },
    ...history,
    { role: "user", content: message },
  ];

  try {
    const resp = await axios.post(
      `${LM_BASE_URL}/v1/chat/completions`,
      {
        model: LM_MODEL,
        messages: msgs,
        temperature: 0.1,
        max_tokens: 512,
      },
      { timeout: TIMEOUT_MS }
    );

    const reply =
      resp?.data?.choices?.[0]?.message?.content?.trim() || "ไม่ทราบ";
    res.json({ reply, used_context: true });
  } catch (err) {
    console.error("LM error:", err?.response?.data || err.message);
    res.status(500).json({ error: "LM request failed" });
  }
});

// ======================================================
// debug reload
// ======================================================
app.post("/api/reload-kb", (_req, res) => {
  FAQ_CACHE = null;
  PROJECTS_CACHE = null;
  PROJECT_LIST = [];
  ensureProjects();
  res.json({ ok: true, projects: PROJECT_LIST.length });
});

// ===== start =====
ensureProjects();

app.listen(PORT, () => {
  console.log(`✅ Server ready → http://localhost:${PORT}`);
  console.log(`➡️ Model: ${LM_MODEL}`);
  console.log(`📚 KB loaded from: ${KB_DIR}`);
});
