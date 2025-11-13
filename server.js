// server.js — LM-only (/api/chat) + RAG แยกส่วน (/api/rag-chat)
// เพิ่ม "Deterministic FAQ" : ตอบจาก kb/faq.txt แบบคำต่อคำก่อนเสมอ
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
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

const isTextFile = f => /\.(md|txt|json)$/i.test(f);

// ===== helpers (ทั่วไป) =====
function normalizeSimple(s = "") {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9ก-๙\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const safeRead = p => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };

// ===== profile (ตอบตรงจากไฟล์) =====
function readProfileFull() {
  try {
    if (!fs.existsSync(PROFILE_FILE)) return null;
    const t = fs.readFileSync(PROFILE_FILE, "utf8").trim();
    return t || null;
  } catch { return null; }
}
function readProfileNameOnly() {
  const full = readProfileFull();
  if (!full) return null;
  const line = full.split(/\r?\n/).find(l => /^ชื่อ\s*:/i.test(l.trim()));
  return line ? line.replace(/^ชื่อ\s*:\s*/i,"").trim() : full;
}
function isAskWhoAboutWan(raw) {
  const rawL = (raw || "").toLowerCase();
  const n = normalizeSimple(raw);
  const reRaw = /(ใครคือ|คือใคร).*(วรรณวรินทร์)(\s*รักญาติ)?/i;
  if (reRaw.test(rawL)) return true;
  return (n.includes("ใครคือ") || n.includes("คือใคร")) &&
         (n.includes("วรรณวรินทร์รักญาติ") || n.includes("วรรณวรินทร์"));
}
function tryProfileAnswer(raw) {
  const n = normalizeSimple(raw).replace(/\s+/g,"");
  if (n === "ฉันคือใคร") return readProfileNameOnly();
  if (isAskWhoAboutWan(raw)) return readProfileFull();
  return null;
}

// ===== Deterministic FAQ (อ่าน faq.txt และตอบ A ตาม Q แบบตรงตัว) =====
let FAQ_CACHE = null; // [{qRaw,qNorm,aRaw}]
function loadFAQ() {
  const raw = safeRead(FAQ_FILE);
  const lines = raw.split(/\r?\n/);
  const items = [];
  let curQ = "", curA = "";
  const flush = () => {
    if (curQ && curA) {
      items.push({ qRaw: curQ.trim(), qNorm: normalizeSimple(curQ), aRaw: curA.trim() });
    }
    curQ = ""; curA = "";
  };
  for (const line of lines) {
    if (/^\s*Q\s*:/i.test(line)) { flush(); curQ = line.replace(/^\s*Q\s*:\s*/i,""); }
    else if (/^\s*A\s*:/i.test(line)) { curA = line.replace(/^\s*A\s*:\s*/i,""); }
    else if (curA) { curA += "\n" + line; } // รองรับ A หลายบรรทัด
  }
  flush();
  FAQ_CACHE = items;
}
function ensureFAQ() { if (FAQ_CACHE === null) loadFAQ(); }

// similarity แบบเบา ๆ (token overlap / Jaccard)
function jaccard(a, b) {
  const sa = new Set(normalizeSimple(a).split(" ").filter(Boolean));
  const sb = new Set(normalizeSimple(b).split(" ").filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// พยายามตอบจาก FAQ แบบคำต่อคำ
function tryFAQAnswer(question) {
  ensureFAQ();
  if (!FAQ_CACHE || !FAQ_CACHE.length) return null;

  const qNorm = normalizeSimple(question);

  // 1) ตรงตัวก่อน (include / startsWith)
  for (const it of FAQ_CACHE) {
    if (qNorm === it.qNorm || it.qNorm.includes(qNorm) || qNorm.includes(it.qNorm)) {
      return it.aRaw; // ส่งคืนจากไฟล์แบบเดิม
    }
  }
  // 2) คล้ายกัน (Jaccard threshold)
  let best = null, bestScore = 0;
  for (const it of FAQ_CACHE) {
    const sc = jaccard(qNorm, it.qNorm);
    if (sc > bestScore) { bestScore = sc; best = it; }
  }
  if (best && bestScore >= 0.5) return best.aRaw; // เกณฑ์กลาง ๆ

  return null;
}

// ===== RAG utils (ใช้เฉพาะ /api/rag-chat เมื่อ FAQ ไม่เจอ) =====
function chunkText(text, size = 900, overlap = 150) {
  const out = []; let i = 0;
  while (i < text.length) {
    const end = Math.min(i + size, text.length);
    out.push(text.slice(i, end));
    if (end === text.length) break;
    i = Math.max(0, end - overlap);
  }
  return out;
}
function tokenize(s = "") {
  return (s || "").toLowerCase().replace(/[^a-z0-9ก-๙\s]/gi, " ").split(/\s+/).filter(Boolean);
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
  const files = fs.readdirSync(KB_DIR).filter(isTextFile);
  const docs = [];
  for (const f of files) {
    const full = path.join(KB_DIR, f);
    const raw = safeRead(full);
    let text = raw;
    if (/\.json$/i.test(f)) { try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch {} }
    const chunks = chunkText(text);
    chunks.forEach((c, idx) => docs.push({ id: `${f}#${idx+1}`, file: f, text: c.trim() }));
  }
  return docs;
}
function retrieveTopK(query, k = 4) {
  const docs = loadKBDocs();
  if (!docs.length) return [];
  return docs
    .map(d => {
      let sc = score(query, d.text);
      const fn = d.file.toLowerCase();
      if (fn.includes("faq")) sc *= 1.2;              // boost faq
      if (fn.includes("company_notes")) sc *= 1.1;    // boost company notes
      return { ...d, _score: sc };
    })
    .filter(d => d._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, k);
}
function buildContext(query, topK = 4) {
  const hits = retrieveTopK(query, topK);
  if (!hits.length) return "";
  return hits.map((h, i) => `【${i+1} • ${h.file}】\n${h.text}`).join("\n\n");
}

// ===== /api/chat — LM only (ไม่มี RAG) =====
app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Missing 'message' (string)" });
  }

  const pAns = tryProfileAnswer(message);
  if (pAns) return res.json({ reply: pAns, answered_from: "profile_pond.txt" });

  const msgs = [
    { role: "system", content: "ตอบสั้น กระชับ ตรงคำถาม เป็นภาษาไทย หากไม่แน่ใจให้ตอบว่า 'ไม่ทราบ' ห้ามเดา" },
    ...history.filter(m => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
              .map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: message }
  ];

  try {
    const resp = await axios.post(`${LM_BASE_URL}/v1/chat/completions`, {
      model: LM_MODEL, messages: msgs, temperature: 0.2, max_tokens: 512
    }, { timeout: TIMEOUT_MS });
    const reply = resp?.data?.choices?.[0]?.message?.content?.trim() || "(ไม่มีคำตอบ)";
    res.json({ reply, answered_from: "lm_only" });
  } catch (err) {
    console.error("LM error:", err?.response?.data || err.message);
    res.status(500).json({ error: "LM request failed", detail: err?.response?.data || err.message });
  }
});

// ===== /api/rag-chat — เช็ค FAQ ก่อน แล้วค่อย RAG ถ้าไม่เจอ =====
app.post("/api/rag-chat", async (req, res) => {
  const { message, history = [], top_k = 4 } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Missing 'message' (string)" });
  }

  // 0) ตอบจาก FAQ แบบคำต่อคำถ้าเจอ (Deterministic)
  const faqAns = tryFAQAnswer(message);
  if (faqAns) {
    return res.json({ reply: faqAns, answered_from: "faq.txt" });
  }

  // 1) ดึง context จาก KB (faq.txt / company_notes.md / ฯลฯ)
  const context = buildContext(message, Math.max(1, Math.min(8, parseInt(top_k,10) || 4)));

  // 2) ส่งเข้ารุ่น พร้อมกำชับให้ยึด context เท่านั้น
  const systemPrompt =
    "คุณคือผู้ช่วยที่ตอบสั้น กระชับ และตรงประเด็นเป็นภาษาไทย " +
    "ให้ใช้ข้อมูลจาก CONTEXT เป็นหลัก หากใน CONTEXT ไม่มีข้อมูล ให้ตอบสั้น ๆ ว่า 'ไม่ทราบ' หรือ 'ไม่มีในข้อมูล' " +
    "ห้ามเดา ห้ามแต่งเติมเกินจริง";

  const msgs = [{ role: "system", content: systemPrompt }];
  if (context) msgs.push({ role: "system", content: "CONTEXT:\n" + context });
  for (const m of history) {
    if (m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant")) {
      msgs.push({ role: m.role, content: m.content });
    }
  }
  msgs.push({ role: "user", content: message });

  try {
    const resp = await axios.post(`${LM_BASE_URL}/v1/chat/completions`, {
      model: LM_MODEL, messages: msgs, temperature: 0.1, max_tokens: 512
    }, { timeout: TIMEOUT_MS });
    const reply = resp?.data?.choices?.[0]?.message?.content?.trim() || "(ไม่มีคำตอบ)";
    res.json({ reply, used_context: Boolean(context) });
  } catch (err) {
    console.error("LM error:", err?.response?.data || err.message);
    res.status(500).json({ error: "LM request failed", detail: err?.response?.data || err.message });
  }
});

// debug / admin
app.post("/api/reload-faq", (_req, res) => { loadFAQ(); res.json({ ok: true, count: FAQ_CACHE?.length || 0 }); });
app.post("/api/reload-kb", (_req, res) => {
  const exists = fs.existsSync(KB_DIR);
  res.json({ ok: true, kb_exists: exists, files: exists ? fs.readdirSync(KB_DIR) : [] });
});

app.listen(PORT, () => {
  console.log(`✅ Server: http://localhost:${PORT}`);
  console.log(`➡️ LM Studio → ${LM_MODEL} @ ${LM_BASE_URL}`);
  console.log(`💬 /api/chat      : LM-only (no RAG)`);
  console.log(`📚 /api/rag-chat  : FAQ first (exact), then RAG over ./kb`);
});
