// ===== Theme toggle (Fixed label) =====
const root = document.documentElement;
const toggle = document.getElementById('themeToggle');
const label = document.getElementById('themeLabel');

const saved =
  localStorage.getItem('theme') ||
  (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light');

root.setAttribute('data-theme', saved);
toggle.checked = saved === 'dark';
label.textContent = saved === 'dark' ? 'Dark' : 'Light';

toggle.addEventListener('change', () => {
  const theme = toggle.checked ? 'dark' : 'light';
  root.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  label.textContent = theme === 'dark' ? 'Dark' : 'Light';
});

// ===== Chat system =====
const chatBox = document.getElementById('chatBox');
const composer = document.getElementById('composer');
const promptEl = document.getElementById('prompt');
const newChatBtn = document.getElementById('newChatBtn');
const heroEl = document.querySelector('.hero');
let history = [];

function appendBubble(text, who = 'me', extraClass = '') {
  const div = document.createElement('div');
  div.className = `chat-msg ${who === 'me' ? 'chat-me' : 'chat-ai'} ${extraClass}`;
  div.textContent = text;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
  return div;
}

let waitEl = null, waitAnim = null;
function startWaiting() {
  stopWaiting();
  waitEl = appendBubble('กำลังประมวลผล', 'ai', 'waiting');
  let dots = 0;
  waitAnim = setInterval(() => {
    dots = (dots + 1) % 4;
    if (waitEl) waitEl.textContent = 'กำลังประมวลผล' + '.'.repeat(dots);
  }, 450);
}
function stopWaiting() {
  if (waitAnim) clearInterval(waitAnim);
  waitAnim = null;
  if (waitEl && waitEl.parentNode) waitEl.parentNode.removeChild(waitEl);
  waitEl = null;
}

function trimHistory(maxTurns = 10) {
  const maxMsgs = maxTurns * 2;
  if (history.length > maxMsgs) {
    history = history.slice(history.length - maxMsgs);
  }
}

newChatBtn?.addEventListener('click', () => {
  history = [];
  chatBox.innerHTML = '';
  if (heroEl) heroEl.classList.remove('hide');
  promptEl.focus();
});

// ===== Send message =====
composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = promptEl.value.trim();
  if (!t) return;

  if (heroEl) heroEl.classList.add('hide');

  appendBubble(t, 'me');
  history.push({ role: 'user', content: t });
  trimHistory(10);
  promptEl.value = '';

  startWaiting();

  try {
    const lower = t.toLowerCase();

    const useRag = (() => {
      const hasPrjPattern = /prj\s*-?\s*(\d{3})/i.test(lower);
      const hasProjectIndex = /(ไฟล์ที่|โครงการที่)\s*\d{1,3}/.test(lower);
      const hasProjectKeywords =
        lower.includes('prj') ||
        lower.includes('โครงการ') ||
        lower.includes('รหัสโครงการ') ||
        lower.includes('project');
      const hasCompanyKeywords =
        lower.includes('transdev') ||
        lower.includes('ทรานส์โค้ด') ||
        lower.includes('ai workspace') ||
        lower.includes('smart city');

      return hasPrjPattern || hasProjectIndex || hasProjectKeywords || hasCompanyKeywords;
    })();

    const endpoint = useRag ? '/api/rag-chat' : '/api/chat';

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: t, history })
    });

    const data = await resp.json();
    stopWaiting();

    if (!resp.ok) {
      appendBubble('(เกิดข้อผิดพลาดจาก LM Studio)', 'ai');
      return;
    }

    const reply = (data.reply || '').trim() || '(ไม่มีการตอบกลับ)';
    appendBubble(reply, 'ai');
    history.push({ role: 'assistant', content: reply });
    trimHistory(10);
  } catch (err) {
    stopWaiting();
    appendBubble('(เกิดข้อผิดพลาด: เชื่อมต่อไม่ได้)', 'ai');
  }
});
