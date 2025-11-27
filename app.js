// ===== Theme toggle (Fixed label) =====
const root = document.documentElement;
const toggle = document.getElementById("themeToggle");
const label = document.getElementById("themeLabel");

const saved =
  localStorage.getItem("theme") ||
  (window.matchMedia &&
  window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light");

root.setAttribute("data-theme", saved);
toggle.checked = saved === "dark";
label.textContent = saved === "dark" ? "Dark" : "Light";

toggle.addEventListener("change", () => {
  const theme = toggle.checked ? "dark" : "light";
  root.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
  label.textContent = theme === "dark" ? "Dark" : "Light";
});

// ===== Chat system =====
const chatBox = document.getElementById("chatBox");
const composer = document.getElementById("composer");
const promptEl = document.getElementById("prompt");
const newChatBtn = document.getElementById("newChatBtn");
const heroEl = document.querySelector(".hero-center");
let history = [];

// append bubble
function appendBubble(text, who = "me", extra = "") {
  const div = document.createElement("div");
  div.className = `chat-msg ${who === "me" ? "chat-me" : "chat-ai"} ${extra}`;
  div.innerText = text;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
  return div;
}

// Waiting indicator
let waitEl = null, waitAnim = null;
function startWaiting() {
  stopWaiting();
  waitEl = appendBubble("กำลังประมวลผล", "ai", "waiting");
  let dots = 0;
  waitAnim = setInterval(() => {
    dots = (dots + 1) % 4;
    waitEl.innerText = "กำลังประมวลผล" + ".".repeat(dots);
  }, 450);
}
function stopWaiting() {
  if (waitAnim) clearInterval(waitAnim);
  if (waitEl && waitEl.parentNode) waitEl.remove();
  waitEl = null;
}

// Trim history
function trimHistory(maxTurns = 10) {
  const max = maxTurns * 2;
  if (history.length > max) history = history.slice(history.length - max);
}

// New chat
newChatBtn.addEventListener("click", () => {
  chatBox.innerHTML = "";
  history = [];
  heroEl.classList.remove("hide");
});

// ===== SEND MESSAGE =====
composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = promptEl.value.trim();
  if (!text) return;

  heroEl.classList.add("hide");

  appendBubble(text, "me");
  history.push({ role: "user", content: text });
  trimHistory();

  promptEl.value = "";
  startWaiting();

  const lower = text.toLowerCase();

  // -------------------------------
  // FIX คำถาม "ใครคือ วรรณวรินทร์"
  // -------------------------------
  if (
    lower.includes("ใครคือ วรรณวรินทร์") ||
    lower.includes("วรรณวรินทร์ รักญาติ") ||
    lower.includes("วรรณวรินทร์ คือใคร")
  ) {
    stopWaiting();

    const profile =
`ชื่อ: วรรณวรินทร์ รักญาติ (Wanwarin Rukyat)
อายุ: 22 ปี
มาจาก: จังหวัดกรุงเทพมหานคร
การศึกษา: ปัจจุบันเป็นนักศึกษาฝึกงานอยู่ที่บริษัททรานส์เดฟ จำกัด
มหาวิทยาลัย: หอการค้าไทย (UTCC) คณะวิทย์และเทคโน สาขาเทคโนโลยีดิจิทัล
จุดเด่น: ทำโปรเจกต์ AI Workspace + RAG, ชอบการออกแบบ UX/UI`;

    appendBubble(profile, "ai");
    history.push({ role: "assistant", content: profile });
    return;
  }

  // ======================================================
  // LM / RAG
  // ======================================================
  try {

    const useRag = (() => {
      const hasPrjPattern = /prj\s*-?\s*(\d{3})/i.test(lower);
      const hasProjectIndex = /(ไฟล์ที่|โครงการที่)\s*\d/.test(lower);
      const hasProjectKeywords =
        lower.includes("รหัสโครงการ") ||
        lower.includes("ข้อมูลโครงการ") ||
        lower.includes("รายละเอียดโครงการ") ||
        /project\s*\d{1,3}/.test(lower);

      const hasCompanyKeywords =
        lower.includes("transdev") ||
        lower.includes("ai workspace") ||
        lower.includes("ทรานส์เดฟ");

      return hasPrjPattern || hasProjectIndex || hasProjectKeywords || hasCompanyKeywords;
    })();

    const endpoint = useRag ? "/api/rag-chat" : "/api/chat";

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, history }),
    });

    const data = await resp.json();
    stopWaiting();

    const reply = (data.reply || "").trim() || "(ไม่มีการตอบกลับ)";
    appendBubble(reply, "ai");
    history.push({ role: "assistant", content: reply });

  } catch (err) {
    stopWaiting();
    appendBubble("(เกิดข้อผิดพลาด: เชื่อมต่อไม่ได้)", "ai");
  }
});
