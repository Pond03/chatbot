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

  // ตรงตัวก่อน
  for (const it of FAQ_CACHE) {
    if (
      qNorm === it.qNorm ||
      qNorm.includes(it.qNorm) ||
      it.qNorm.includes(qNorm)
    )
      return it.aRaw;
  }

  // คล้ายกัน
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
//   PROJECT KB (deterministic) + index-based access
// ======================================================
let PROJECTS_CACHE = null; // map: code -> proj
let PROJECT_LIST = [];     // array ตามลำดับไฟล์: index 0 = ไฟล์ที่ 1

function loadProjects() {
  const map = {};
  const list = {};

  console.log("📂 PROJECT_DIR =", PROJECT_DIR, "exists?", fs.existsSync(PROJECT_DIR));
  if (!fs.existsSync(PROJECT_DIR)) return { map: {}, list: [] };

  let fileNames = fs
    .readdirSync(PROJECT_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".txt"))
    .map((d) => d.name);

  // เรียงตามชื่อไฟล์: PRJ-001.txt, PRJ-002.txt, ...
  fileNames = fileNames.sort();
  console.log("📄 Project files =", fileNames);

  const arr = [];

  fileNames.forEach((name, idx) => {
    const full = path.join(PROJECT_DIR, name);
    const raw = safeRead(full);
    if (!raw) return;

    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const proj = { raw, file: name, index: idx + 1 }; // index: ไฟล์ที่ 1,2,...

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
  console.log("📁 Loaded projects:", Object.keys(PROJECTS_CACHE));
}

// ดึง code จากข้อความ (เช่น มี PRJ-001)
function extractProjectCode(message) {
  const upper = (message || "").toUpperCase();
  const m = upper.match(/PRJ[\s\-]?(\d{3})/);
  if (!m) return null;
  return `PRJ-${m[1]}`;
}

// ดึง index จาก "ไฟล์ที่ 1" / "โครงการที่ 3"
function extractProjectIndex(message) {
  const m = (message || "").match(/(ไฟล์ที่|โครงการที่)\s*(\d{1,3})/);
  if (!m) return null;
  const idx = parseInt(m[2], 10);
  return Number.isNaN(idx) ? null : idx;
}

// 👉 ตรงนี้คือรูปแบบคำตอบใหม่แบบที่ต้องการ
function formatProjectFull(proj) {
  return [
    `รหัสโครงการ - ${proj.code || "-"}`,
    `ชื่อโครงการ - ${proj.name || "-"}`,
    `มูลค่าโครงการ (บาท) - ${proj.budget || "-"}`,
    `วันที่เริ่มต้น - ${proj.start_date || "-"}`,
    `วันที่สิ้นสุด - ${proj.end_date || "-"}`,
    `ระยะเวลา (วัน) - ${proj.duration || "-"}`,
    `ผู้รับผิดชอบ - ${proj.owner || "-"}`
  ].join("\n");
}

function tryProjectAnswer(message) {
  if (!PROJECTS_CACHE) ensureProjects();

  const msg = message || "";
  const lower = msg.toLowerCase();

  const idx = extractProjectIndex(msg);        // ไฟล์ที่ 1 / โครงการที่ 1
  const codeFromText = extractProjectCode(msg); // PRJ-001

  let proj = null;
  let fromIndex = false;

  if (idx && PROJECT_LIST[idx - 1]) {
    proj = PROJECT_LIST[idx - 1];
    fromIndex = true;
  } else if (codeFromText && PROJECTS_CACHE[codeFromText]) {
    proj = PROJECTS_CACHE[codeFromText];
  }

  if (!proj) return null;

  const code = proj.code;

  // ===== คำถามรหัสโครงการจาก "ไฟล์ที่ / โครงการที่" =====
  if (fromIndex && (lower.includes("รหัสไฟล์") || lower.includes("รหัสโครงการ"))) {
    return `รหัสโครงการของไฟล์ที่ ${proj.index} คือ ${code}`;
  }

  // ===== คำถาม "ไฟล์ที่ X มีข้อมูลอะไรบ้าง" =====
  if (
    (lower.includes("มีข้อมูลอะไรบ้าง") || lower.includes("รายละเอียดอะไรบ้าง")) &&
    (lower.includes("ไฟล์ที่") || lower.includes("โครงการที่"))
  ) {
    return formatProjectFull(proj);
  }

  // ===== คำถามตาม 7 ฟิลด์เดิม =====
  if (lower.includes("รหัสโครงการ")) {
    return `รหัสโครงการของโครงการนี้คือ ${code}`;
  }
  if (lower.includes("ชื่อโครงการ")) {
    const n = proj.name || "ไม่ทราบชื่อ";
    return `ชื่อโครงการ ${code} คือ ${n}`;
  }
  if (lower.includes("มูลค่าโครงการ") || lower.includes("มูลค่า")) {
    const b = proj.budget || "ไม่ทราบ";
    return `มูลค่าโครงการ ${code} คือ ${b} บาท`;
  }
  if (lower.includes("วันที่เริ่มต้น")) {
    const v = proj.start_date || "ไม่ทราบ";
    return `วันที่เริ่มต้นของโครงการ ${code} คือ ${v}`;
  }
  if (lower.includes("วันที่สิ้นสุด") || lower.includes("วันสิ้นสุด")) {
    const v = proj.end_date || "ไม่ทราบ";
    return `วันที่สิ้นสุดของโครงการ ${code} คือ ${v}`;
  }
  if (lower.includes("ระยะเวลา")) {
    const v = proj.duration || "ไม่ทราบ";
    return `ระยะเวลาโครงการ ${code} คือ ${v}`;
  }
  if (lower.includes("ผู้รับผิดชอบ")) {
    const o = proj.owner || "ไม่ระบุ";
    return `ผู้รับผิดชอบโครงการ ${code} คือ ${o}`;
  }

  // ถามกว้าง ๆ เช่น "รายละเอียด PRJ-001"
  return formatProjectFull(proj);
}

// ======================================================
//   RAG — ทั่วไป (KB อื่น ๆ)
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

  console.log("🔎 RAG hits for query:", query);
  hits.forEach((h) => {
    console.log("  ->", h.file, "score", h._score.toFixed(3));
  });

  return hits
    .map((h, i) => `【${i + 1} • ${h.file}】\n${h.text}`)
    .join("\n\n");
}

// ======================================================
//   /api/chat (LM only) — คุยทั่วไป + โปรไฟล์
// ======================================================
app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body || {};

  if (!message || typeof message !== "string")
    return res.status(400).json({ error: "Missing 'message'" });

  // โปรไฟล์
  const pAns = tryProfileAnswer(message);
  if (pAns)
    return res.json({ reply: pAns, answered_from: "profile_pond.txt" });

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
      resp?.data?.choices?.[0]?.message?.content?.trim() || "(ไม่มีคำตอบ)";
    res.json({ reply, answered_from: "lm_only" });
  } catch (err) {
    console.error("LM error:", err?.response?.data || err.message);
    res.status(500).json({ error: "LM request failed" });
  }
});

// ======================================================
//   /api/rag-chat → Profile → Project → FAQ → RAG+LM
// ======================================================
app.post("/api/rag-chat", async (req, res) => {
  const { message, history = [], top_k = 4 } = req.body || {};

  if (!message)
    return res.status(400).json({ error: "Missing 'message'" });

  // 0) โปรไฟล์
  const pAns = tryProfileAnswer(message);
  if (pAns) {
    return res.json({ reply: pAns, answered_from: "profile_pond.txt" });
  }

  // 1) Project deterministic (PRJ-xxx / ไฟล์ที่ / โครงการที่)
  const projAns = tryProjectAnswer(message);
  if (projAns) {
    return res.json({ reply: projAns, answered_from: "projects" });
  }

  // 2) FAQ
  const faqAns = tryFAQAnswer(message);
  if (faqAns) {
    return res.json({ reply: faqAns, answered_from: "faq.txt" });
  }

  // 3) RAG ทั่วไป
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

  const msgs = [{ role: "system", content: systemPrompt }];
  msgs.push({ role: "system", content: "CONTEXT:\n" + context });

  history.forEach((m) => msgs.push(m));
  msgs.push({ role: "user", content: message });

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
      resp?.data?.choices?.[0]?.message?.content?.trim() || "(ไม่มีคำตอบ)";
    res.json({ reply, used_context: true });
  } catch (err) {
    console.error("LM error:", err?.response?.data || err.message);
    res.status(500).json({ error: "LM request failed" });
  }
});

// debug / admin
app.post("/api/reload-faq", (_req, res) => {
  loadFAQ();
  res.json({ ok: true, count: FAQ_CACHE?.length || 0 });
});

app.post("/api/reload-kb", (_req, res) => {
  FAQ_CACHE = null;
  PROJECTS_CACHE = null;
  PROJECT_LIST = [];
  ensureProjects();
  const exists = fs.existsSync(KB_DIR);
  const files = exists
    ? glob.sync(path.join(KB_DIR, "**/*"), { nodir: true })
    : [];
  res.json({ ok: true, kb_exists: exists, files });
});

// ===== โหลดโปรเจกต์ตอนสตาร์ต =====
ensureProjects();

// ======================================================
app.listen(PORT, () => {
  console.log(`✅ Server ready → http://localhost:${PORT}`);
  console.log(`➡️ Model: ${LM_MODEL}`);
  console.log(`📚 KB loaded from: ${KB_DIR}`);
});
