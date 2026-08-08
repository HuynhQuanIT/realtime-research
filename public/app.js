// Màu theo kênh — dùng chung cho card, chip, và biểu đồ Chart.js
const COLORS = {
  poll: '#f59e0b',
  sse:  '#10b981',
  ws:   '#4f46e5',
  fcm:  '#ec4899'
};

// ---------------------------------------------------------------
// ĐIỀU HƯỚNG SIDEBAR — chuyển view, không reload trang.
// Các kết nối chat/live-demo vẫn chạy nền dù đang xem view khác,
// nên rời tab Chat rồi quay lại không mất tin nhắn.
// ---------------------------------------------------------------
const VIEW_META = {
  home:    { eyebrow: 'Notify Bench · Trang chủ',      title: 'Xin chào 👋',                  sub: () => 'Tổng quan hệ thống so sánh Polling · SSE · WebSocket · FCM' },
  compare: { eyebrow: 'Notify Bench · So sánh cơ chế',  title: 'So sánh 4 cơ chế real-time',    sub: () => 'Cùng 1 nguồn Postgres LISTEN/NOTIFY, đo latency thật của từng kênh' },
  chat:    { eyebrow: 'Notify Bench · Chat thử nghiệm', title: 'Chat thử nghiệm 2 chiều',       sub: () => `Đang ở phòng: ${currentRoom}` },
  profile: { eyebrow: 'Notify Bench · Cá nhân',         title: 'Thông tin cá nhân',              sub: () => 'Tên hiển thị và phòng đang tham gia' },
};

function switchView(view){
  document.querySelectorAll('.view').forEach(el => el.style.display = 'none');
  document.getElementById('view-' + view).style.display = '';
  document.querySelectorAll('.nav-item[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === view));

  const meta = VIEW_META[view];
  document.getElementById('viewEyebrow').textContent = meta.eyebrow;
  document.getElementById('viewTitle').textContent = meta.title;
  document.getElementById('viewSubtitle').textContent = meta.sub();

  if (view === 'home') loadHomeStats();
  if (view === 'profile') renderProfile();
}

document.querySelectorAll('.nav-item[data-view]').forEach(item => {
  item.addEventListener('click', () => switchView(item.dataset.view));
});
document.querySelectorAll('[data-goto]').forEach(el => {
  el.addEventListener('click', () => switchView(el.dataset.goto));
});

function pulse(method, latencyMs){
  const chan = document.getElementById('chan-'+method);
  const reading = document.getElementById(method+'-reading');
  const bead = document.getElementById(method+'-bead');
  const countEl = document.getElementById(method+'-count');
  reading.innerHTML = Math.round(latencyMs) + ' <small>ms</small>';
  chan.classList.add('pulse');
  setTimeout(()=>chan.classList.remove('pulse'), 400);
  bead.classList.remove('run'); void bead.offsetWidth; bead.classList.add('run');
  countEl.textContent = (parseInt(countEl.textContent,10) + 1);
}

// ---------------------------------------------------------------
// CHAT 2 CHIỀU — theo PHÒNG (room)
// Có 4 kết nối RIÊNG (không dùng chung với 4 card Live Demo phía trên),
// đều mở kèm ?room=<currentRoom> nên chỉ nhận tin nhắn đúng phòng.
// Đổi phòng -> đóng 4 kết nối cũ, mở lại 4 kết nối mới theo phòng mới.
// ---------------------------------------------------------------
const seenMsgIds = new Set();
const tally = { poll: 0, sse: 0, ws: 0, fcm: 0 };
const chatLog = document.getElementById('chatLog');
const chatNameInput = document.getElementById('chatName');
const chatRoomInput = document.getElementById('chatRoom');
const tallyList = document.getElementById('tallyList');
const CHAT_LABELS = { poll: 'Polling', sse: 'SSE', ws: 'WebSocket', fcm: 'FCM' };

chatNameInput.value = localStorage.getItem('chatName') || ('User-' + Math.floor(1000 + Math.random() * 9000));
localStorage.setItem('chatName', chatNameInput.value);

function applyDisplayName(name){
  chatNameInput.value = name;
  localStorage.setItem('chatName', name);
  document.getElementById('sidebarName').textContent = name;
  document.getElementById('sidebarAvatar').textContent = name.slice(0, 2).toUpperCase();
  const pi = document.getElementById('profileNameInput');
  if (pi) pi.value = name;
  const pa = document.getElementById('profileAvatar');
  if (pa) pa.textContent = name.slice(0, 2).toUpperCase();
}
applyDisplayName(chatNameInput.value);
chatNameInput.addEventListener('change', () => applyDisplayName(chatNameInput.value.trim() || chatNameInput.value));

let currentRoom = localStorage.getItem('chatRoom') || 'lobby';
chatRoomInput.value = currentRoom;
chatRoomInput.placeholder = 'lobby';

const roomTabbar = document.getElementById('roomTabbar');
let lastRoomList = [];

async function loadRoomList(){
  try{
    const res = await fetch('/rooms');
    const { rooms } = await res.json();
    lastRoomList = rooms || [];
    if (!rooms || rooms.length === 0){
      roomTabbar.innerHTML = '<span class="room-chip-empty">Chưa có phòng nào — gửi tin để tạo phòng đầu tiên.</span>';
    } else {
      roomTabbar.innerHTML = rooms.map(r => `
        <button class="room-chip ${r.room === currentRoom ? 'active' : ''}" data-room="${r.room}">
          ${r.room} <span class="n">${r.msg_count}</span>
        </button>
      `).join('');
      roomTabbar.querySelectorAll('.room-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const room = chip.dataset.room;
          chatRoomInput.value = room;
          joinRoom(room);
        });
      });
    }
    renderHomeRoomList();
  }catch(e){}
}

function renderHomeRoomList(){
  const el = document.getElementById('homeRoomList');
  if (!el) return;
  if (!lastRoomList.length){
    el.innerHTML = '<div class="room-chip-empty">Chưa có phòng nào hoạt động.</div>';
    return;
  }
  const dotColors = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ec4899'];
  el.innerHTML = lastRoomList.slice(0, 6).map((r, i) => `
    <div class="sched-item" data-room="${r.room}">
      <div class="info">
        <div class="dotbar" style="background:${dotColors[i % dotColors.length]}"></div>
        <div><div class="st">${r.room}</div><div class="sr">${r.msg_count} tin nhắn</div></div>
      </div>
      <div class="sd num">${new Date(r.last_at).toLocaleDateString('vi-VN')}</div>
    </div>
  `).join('');
  el.querySelectorAll('.sched-item').forEach(item => {
    item.addEventListener('click', () => {
      chatRoomInput.value = item.dataset.room;
      joinRoom(item.dataset.room);
      switchView('chat');
    });
  });
}

function renderTally(){
  tallyList.innerHTML = Object.keys(tally).map(m => `
    <div class="tally-row">
      <span><span class="tally-dot" style="background:${COLORS[m]}"></span>${CHAT_LABELS[m]}</span>
      <b>${tally[m]}</b>
    </div>
  `).join('');
}
renderTally();

function appendChatMessage(payload, viaMethod, latencyMs){
  const mine = payload.sender === chatNameInput.value;
  const row = document.createElement('div');
  row.className = 'msg-row ' + (mine ? 'me' : 'them');
  const metaHtml = viaMethod === 'history'
    ? `<span>${new Date(payload.created_at).toLocaleTimeString('vi-VN')}</span>`
    : `<span class="via-badge via-${viaMethod}">${viaMethod.toUpperCase()}</span><span>${Math.max(0, Math.round(latencyMs))}ms</span>`;
  row.innerHTML = `
    <div class="msg-sender">${mine ? 'Bạn' : (payload.sender || 'ẩn danh')}</div>
    <div class="msg-bubble"></div>
    <div class="msg-meta">${metaHtml}</div>
  `;
  row.querySelector('.msg-bubble').textContent = payload.content;
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function handleChatIncoming(method, payload, latencyMs){
  if (seenMsgIds.has(payload.id)) return;
  seenMsgIds.add(payload.id);
  tally[method] = (tally[method] || 0) + 1;
  renderTally();
  appendChatMessage(payload, method, latencyMs);
}

let chatWs, chatEs, chatFcmEs, chatPollTimer;

function teardownChatConnections(){
  if (chatWs) { chatWs.onclose = null; chatWs.close(); }
  if (chatEs) chatEs.close();
  if (chatFcmEs) chatFcmEs.close();
  if (chatPollTimer) clearInterval(chatPollTimer);
}

function connectChatWs(room){
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  chatWs = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}`);
  chatWs.onmessage = (evt) => {
    try{
      const payload = JSON.parse(evt.data);
      handleChatIncoming('ws', payload, Date.now() - new Date(payload.created_at).getTime());
    }catch(e){}
  };
}

function connectChatSse(room){
  chatEs = new EventSource('/sse?room=' + encodeURIComponent(room));
  chatEs.onmessage = (evt) => {
    try{
      const payload = JSON.parse(evt.data);
      handleChatIncoming('sse', payload, Date.now() - new Date(payload.created_at).getTime());
    }catch(e){}
  };
}

function connectChatPoll(room){
  let since = new Date().toISOString();
  chatPollTimer = setInterval(async () => {
    try{
      const res = await fetch(`/poll?since=${encodeURIComponent(since)}&room=${encodeURIComponent(room)}`);
      const data = await res.json();
      since = data.serverTime;
      data.items.forEach(item => handleChatIncoming('poll', item, Date.now() - new Date(item.created_at).getTime()));
    }catch(e){}
  }, 2000);
}

function connectChatFcm(room){
  const token = 'chat-' + Math.random().toString(36).slice(2);
  fetch('/fcm/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
    .then(() => {
      chatFcmEs = new EventSource('/fcm/stream?room=' + encodeURIComponent(room));
      chatFcmEs.onmessage = (evt) => {
        try{
          const payload = JSON.parse(evt.data);
          handleChatIncoming('fcm', payload, Date.now() - new Date(payload.created_at).getTime());
        }catch(e){}
      };
    });
}

function joinRoom(room){
  teardownChatConnections();
  seenMsgIds.clear();
  tally.poll = tally.sse = tally.ws = tally.fcm = 0;
  renderTally();
  chatLog.innerHTML = '';

  currentRoom = room;
  localStorage.setItem('chatRoom', room);
  loadRoomList();
  if (document.getElementById('view-chat').style.display !== 'none'){
    document.getElementById('viewSubtitle').textContent = VIEW_META.chat.sub();
  }
  const pcr = document.getElementById('profileCurrentRoom');
  if (pcr) pcr.textContent = room;

  fetch('/messages?room=' + encodeURIComponent(room) + '&limit=50')
    .then(r => r.json())
    .then(({ items }) => {
      (items || []).forEach(item => { seenMsgIds.add(item.id); appendChatMessage(item, 'history', 0); });
    })
    .catch(() => {});

  connectChatWs(room);
  connectChatSse(room);
  connectChatPoll(room);
  connectChatFcm(room);
}

chatRoomInput.addEventListener('change', () => {
  const newRoom = chatRoomInput.value.trim() || 'lobby';
  chatRoomInput.value = newRoom;
  joinRoom(newRoom);
});

joinRoom(currentRoom); // vào phòng lần đầu khi mở trang

async function sendChat(){
  const input = document.getElementById('chatInput');
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  try {
    await fetch('/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, sender: chatNameInput.value, room: currentRoom }),
    });
    loadRoomList();
  } catch (e) {}
}
document.getElementById('chatSendBtn').addEventListener('click', sendChat);
document.getElementById('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

let sentCount = 0;
document.getElementById('sendBtn').addEventListener('click', async () => {
  sentCount += 1;
  document.getElementById('sentCount').textContent = `Đã gửi ${sentCount} message`;
  await fetch('/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({content:`ui-demo-${Date.now()}`, sender: 'live-demo'})
  });
});

document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const tab = btn.dataset.tab;
  const grid = document.getElementById('chanGrid');
  grid.classList.toggle('single', tab !== 'all');
  document.querySelectorAll('.chan').forEach(c => {
    c.style.display = (tab === 'all' || c.dataset.method === tab) ? '' : 'none';
  });
}));

// WebSocket (card Live Demo — không lọc room, luôn thấy toàn bộ traffic)
function connectWs(){
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  const statusEl = document.getElementById('wsStatus');
  ws.onopen = () => statusEl.innerHTML = '<span class="dot" style="background:#10b981;width:6px;height:6px;border-radius:50%;box-shadow:0 0 6px #10b981"></span> WS: đã kết nối';
  ws.onclose = () => { statusEl.innerHTML = '<span class="dot" style="background:#ef4444;width:6px;height:6px;border-radius:50%;"></span> WS: mất kết nối'; setTimeout(connectWs, 1500); };
  ws.onerror = () => ws.close();
  ws.onmessage = (evt) => {
    try{
      const payload = JSON.parse(evt.data);
      pulse('ws', Date.now() - new Date(payload.created_at).getTime());
    }catch(e){}
  };
}
connectWs();

// SSE
const es = new EventSource('/sse');
es.onmessage = (evt) => {
  try{
    const payload = JSON.parse(evt.data);
    pulse('sse', Date.now() - new Date(payload.created_at).getTime());
  }catch(e){}
};

// Polling
let pollSince = new Date().toISOString();
setInterval(async () => {
  try{
    const res = await fetch('/poll?since=' + encodeURIComponent(pollSince));
    const data = await res.json();
    pollSince = data.serverTime;
    data.items.forEach(item => pulse('poll', Date.now() - new Date(item.created_at).getTime()));
  }catch(e){}
}, 2000);

// FCM (mock)
const fcmToken = 'ui-' + Math.random().toString(36).slice(2);
fetch('/fcm/register', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({token: fcmToken})})
  .then(() => {
    const esFcm = new EventSource('/fcm/stream');
    esFcm.onmessage = (evt) => {
      try{
        const payload = JSON.parse(evt.data);
        pulse('fcm', Date.now() - new Date(payload.created_at).getTime());
      }catch(e){}
    };
  });

// ---- Chạy benchmark từ UI ----
const benchLogEl = document.getElementById('benchLog');
const benchStatusEl = document.getElementById('benchStatus');
const benchQuickBtn = document.getElementById('benchQuickBtn');
const benchFullBtn = document.getElementById('benchFullBtn');

function setBenchButtonsDisabled(disabled){
  benchQuickBtn.disabled = disabled;
  benchFullBtn.disabled = disabled;
}

async function startBench(preset){
  try{
    const res = await fetch('/bench/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset }),
    });
    if (res.status === 409){
      benchStatusEl.textContent = 'Benchmark đang chạy rồi, đợi xong đã.';
      return;
    }
  }catch(e){
    benchStatusEl.textContent = 'Không gọi được /bench/start: ' + e.message;
    return;
  }

  setBenchButtonsDisabled(true);
  benchStatusEl.textContent = 'Đang chạy…';
  benchLogEl.style.display = 'block';
  benchLogEl.textContent = '';

  const stream = new EventSource('/bench/stream');
  stream.addEventListener('log', (evt) => {
    benchLogEl.textContent += JSON.parse(evt.data);
    benchLogEl.scrollTop = benchLogEl.scrollHeight;
  });
  stream.addEventListener('done', () => {
    stream.close();
    setBenchButtonsDisabled(false);
    benchStatusEl.textContent = 'Xong — đang tải lại biểu đồ…';
    loadDashboard().then(() => {
      benchStatusEl.textContent = 'Đã cập nhật dashboard.';
      loadHomeStats();
    });
  });
  stream.onerror = () => {
    stream.close();
    setBenchButtonsDisabled(false);
    benchStatusEl.textContent = 'Mất kết nối stream log (benchmark có thể vẫn đang chạy ở server).';
  };
}

benchQuickBtn.addEventListener('click', () => startBench(true));
benchFullBtn.addEventListener('click', () => startBench(false));
document.getElementById('homeRunBenchBtn').addEventListener('click', () => {
  switchView('compare');
  startBench(true);
});

async function loadDashboard(){
  const sub = document.getElementById('dashSub');
  const area = document.getElementById('dashArea');
  if (typeof Chart === 'undefined') {
    sub.textContent = 'Không tải được thư viện vẽ biểu đồ';
    area.innerHTML = '<div class="empty-state">Thiếu <code>public/vendor/chart.umd.js</code>. Chạy <code>npm install</code> rồi kiểm tra lại thư mục <code>public/vendor/</code>.</div>';
    return;
  }
  try{
    const res = await fetch('/results');
    const { file, rows } = await res.json();
    if (!rows || rows.length === 0){
      sub.textContent = 'Chưa có kết quả benchmark';
      area.innerHTML = '<div class="empty-state">Không tìm thấy file kết quả trong <code>loadtest/results/</code>. Bấm "Chạy nhanh" ở trên để tạo dữ liệu.</div>';
      return;
    }
    sub.textContent = `Nguồn dữ liệu: ${file} · ${rows.length} lượt đo`;

    const methods = [...new Set(rows.map(r=>r.method))];
    const clientLevels = [...new Set(rows.map(r=>r.clients))].sort((a,b)=>a-b);

    area.innerHTML = `
      <div class="dash-grid">
        <div class="card"><h3>Latency trung bình (ms)</h3><canvas id="chartLatency"></canvas></div>
        <div class="card"><h3>Latency p95 (ms)</h3><canvas id="chartP95"></canvas></div>
        <div class="card"><h3>RAM Server sử dụng (MB)</h3><canvas id="chartRam"></canvas></div>
        <div class="card"><h3>CPU Tăng trung bình (ms / sample)</h3><canvas id="chartCpu"></canvas></div>
      </div>
      <div class="card" style="margin-top:16px;">
        <h3>Bảng số liệu chi tiết</h3>
        <div style="overflow-x:auto;">
        <table>
          <thead><tr><th>Cơ chế</th><th>Clients</th><th>Latency avg</th><th>p50</th><th>p95</th><th>p99</th><th>RAM avg</th><th>RAM max</th><th>CPU/sample</th></tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td><span class="method-badge badge-${r.method}">${r.method}</span></td>
              <td><b class="num">${r.clients}</b></td>
              <td style="color:${COLORS[r.method]};font-weight:600;">${Number(r.latency_avg_ms).toFixed(1)} ms</td>
              <td>${r.latency_p50_ms} ms</td>
              <td>${r.latency_p95_ms} ms</td>
              <td>${r.latency_p99_ms} ms</td>
              <td>${Number(r.ram_avg_mb).toFixed(1)} MB</td>
              <td>${Number(r.ram_max_mb).toFixed(1)} MB</td>
              <td>${Number(r.cpu_user_ms_per_sample).toFixed(1)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        </div>
      </div>
    `;

    const dataset = (metricKey) => methods.map(m => ({
      label: m.toUpperCase(),
      borderColor: COLORS[m] || '#0b0b0c',
      backgroundColor: COLORS[m] || '#0b0b0c',
      borderWidth: 3,
      pointRadius: 4,
      pointHoverRadius: 6,
      pointBackgroundColor: '#fff',
      pointBorderWidth: 2,
      data: clientLevels.map(c => {
        const row = rows.find(r => r.method===m && r.clients===c);
        return row ? Number(row[metricKey]) : null;
      }),
      tension: 0.25,
      spanGaps: true,
    }));

    const baseOpts = {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          grid: { color: '#e8e9ed' },
          ticks: { color: '#70737c', font: { family: 'JetBrains Mono', size: 11 } },
          title: { display: true, text: 'Số lượng Clients kết nối', color: '#70737c', font: { size: 11 } }
        },
        y: {
          grid: { color: '#e8e9ed' },
          ticks: { color: '#70737c', font: { family: 'JetBrains Mono', size: 11 } }
        }
      },
      plugins: {
        legend: {
          labels: { color: '#0b0b0c', font: { family: 'JetBrains Mono', size: 12, weight: 'bold' }, usePointStyle: true, pointStyle: 'circle' }
        }
      }
    };

    new Chart(document.getElementById('chartLatency'), { type:'line', data:{labels:clientLevels, datasets:dataset('latency_avg_ms')}, options: baseOpts });
    new Chart(document.getElementById('chartP95'), { type:'line', data:{labels:clientLevels, datasets:dataset('latency_p95_ms')}, options: baseOpts });
    new Chart(document.getElementById('chartRam'), { type:'line', data:{labels:clientLevels, datasets:dataset('ram_avg_mb')}, options: baseOpts });
    new Chart(document.getElementById('chartCpu'), { type:'line', data:{labels:clientLevels, datasets:dataset('cpu_user_ms_per_sample')}, options: baseOpts });

    return rows;
  }catch(e){
    sub.textContent = 'Lỗi tải dữ liệu';
    area.innerHTML = `<div class="empty-state">Lỗi: ${e.message}</div>`;
  }
}

// ---------------------------------------------------------------
// TRANG CHỦ — số liệu tổng quan lấy từ /rooms + /results
// ---------------------------------------------------------------
async function loadHomeStats(){
  try{
    const roomsRes = await fetch('/rooms');
    const { rooms } = await roomsRes.json();
    lastRoomList = rooms || [];
    document.getElementById('statRooms').textContent = (rooms || []).length;
    document.getElementById('statMessages').textContent = (rooms || []).reduce((s, r) => s + r.msg_count, 0);
    renderHomeRoomList();
  }catch(e){}

  try{
    const res = await fetch('/results');
    const { rows } = await res.json();
    document.getElementById('statRuns').textContent = (rows || []).length;
  }catch(e){
    document.getElementById('statRuns').textContent = '0';
  }
}

function renderProfile(){
  document.getElementById('profileNameInput').value = chatNameInput.value;
  document.getElementById('profileAvatar').textContent = chatNameInput.value.slice(0, 2).toUpperCase();
  document.getElementById('profileCurrentRoom').textContent = currentRoom;
}
document.getElementById('profileNameInput').addEventListener('change', (e) => {
  const name = e.target.value.trim();
  if (!name) return;
  applyDisplayName(name);
});

// Khởi động
loadDashboard();
loadHomeStats();