// ========== Hub 页面逻辑 ==========
const socket = connectSocket();

let currentUser = null;

// 游戏列表（硬编码）
const GAMES = [
  {
    code: 'dfw',
    name: '大富翁',
    icon: '🎲',
    description: '经典大富翁联机版，策略与运气的对决',
    path: '/dfw',
  },
  {
    code: 'uno',
    name: 'UNO',
    icon: '🃏',
    description: '经典UNO卡牌游戏，考验反应与策略',
    path: '/uno',
  },
];

// ========== 初始化 ==========
async function init() {
  // 恢复主题
  const savedTheme = localStorage.getItem('theme') || 'dark';
  document.documentElement.dataset.theme = savedTheme;

  // 检查登录状态
  await checkLoginStatus();

  // 加载侧边栏数据
  loadFriendLinks();
  loadAds();
  loadOnlineStats();

  // 定时刷新在线统计
  setInterval(loadOnlineStats, 10000);
}

// ========== 登录状态检查 ==========
async function checkLoginStatus() {
  try {
    const res = await apiFetch('/api/me');
    const data = await res.json();
    if (data.loggedIn) {
      currentUser = data.user;
      showGamesSection();
      renderUserBar(data.user, data.stats, data.statsByType);
      renderMyStats(data.statsByType);
      renderHistoryTabs();
      loadHistory();
      socket.emit('syncUser', {
        userId: data.user.id,
        username: data.user.username,
        nickname: data.user.nickname,
        avatar: data.user.avatar,
        qq: data.user.qq,
      });
    } else {
      showLoginSection();
    }
  } catch (e) {
    showLoginSection();
  }
}

function showLoginSection() {
  document.getElementById('hub-login-section').style.display = '';
  document.getElementById('hub-games-section').style.display = 'none';
  document.getElementById('hub-user-bar').innerHTML = '';
}

function showGamesSection() {
  document.getElementById('hub-login-section').style.display = 'none';
  document.getElementById('hub-games-section').style.display = '';
  renderGamesList();
}

function renderUserBar(user, stats, statsByType) {
  const bar = document.getElementById('hub-user-bar');
  let html = '';
  if (user.avatar) {
    html += `<img src="${user.avatar}" class="hub-avatar" alt="" onerror="this.style.display='none'">`;
  }
  html += `<div>`;
  html += `<div class="hub-username">${escapeHtml(user.nickname)}`;
  if (user.is_admin) {
    html += ` <a href="/admin" class="admin-link" style="font-size:12px;color:var(--accent-yellow);text-decoration:none;margin-left:8px;">⚙️ 管理</a>`;
  }
  html += `</div>`;
  // 用户栏只显示总场次，详细战绩在下方按游戏类型分开
  if (stats) {
    html += `<div class="hub-stats-mini">总${stats.total_games}场</div>`;
  }
  html += `</div>`;
  html += `<button class="btn btn-danger btn-small" onclick="logout()">退出</button>`;
  bar.innerHTML = html;
}

// ========== 我的战绩（按游戏类型分开） ==========
function renderMyStats(statsByType) {
  const container = document.getElementById('my-stats-list');
  if (!container) return;
  if (!statsByType) {
    container.innerHTML = '<div class="stats-empty">暂无战绩数据</div>';
    return;
  }

  const games = [
    { type: 'monopoly', name: '大富翁', icon: '🎲' },
    { type: 'uno', name: 'UNO', icon: '🃏' },
  ];

  container.innerHTML = games.map(g => {
    const s = statsByType[g.type] || { wins: 0, losses: 0, total: 0 };
    const winRate = s.total > 0 ? Math.round(s.wins / s.total * 100) : 0;
    return `
      <div class="my-stat-card my-stat-${g.type}">
        <div class="my-stat-icon">${g.icon}</div>
        <div class="my-stat-info">
          <div class="my-stat-name">${g.name}</div>
          <div class="my-stat-detail">
            <span class="stat-win">胜 ${s.wins}</span>
            <span class="stat-loss">负 ${s.losses}</span>
            <span class="stat-rate">胜率 ${winRate}%</span>
            <span class="stat-total">${s.total} 场</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ========== 最近对局（按游戏类型分开） ==========
let currentHistoryTab = 'monopoly';

function renderHistoryTabs() {
  const tabs = document.getElementById('history-tabs');
  if (!tabs) return;
  const games = [
    { type: 'monopoly', name: '🎲 大富翁' },
    { type: 'uno', name: '🃏 UNO' },
  ];
  tabs.innerHTML = games.map(g => `
    <button class="history-tab ${currentHistoryTab === g.type ? 'active' : ''}" data-type="${g.type}">${g.name}</button>
  `).join('');
  tabs.querySelectorAll('.history-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      currentHistoryTab = btn.dataset.type;
      renderHistoryTabs();
      loadHistory();
    });
  });
}

async function loadHistory() {
  const container = document.getElementById('history-list');
  if (!container) return;
  container.innerHTML = '<div class="history-loading">加载中...</div>';
  try {
    const res = await apiFetch(`/api/history?game_type=${currentHistoryTab}&limit=15`);
    const history = await res.json();
    if (!history || history.length === 0) {
      container.innerHTML = '<div class="history-empty">暂无对局记录</div>';
      return;
    }
    container.innerHTML = history.map(h => {
      const gameLabel = h.game_type === 'uno' ? '🃏 UNO' : '🎲 大富翁';
      // ended_at 可能是毫秒(13位)或秒(10位)
      const ts = h.ended_at > 1e12 ? h.ended_at : h.ended_at * 1000;
      const time = h.ended_at ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      // duration 可能是毫秒或秒
      const durSec = h.duration > 100000 ? Math.floor(h.duration / 1000) : h.duration;
      const duration = durSec > 0 ? `${Math.floor(durSec / 60)}分${durSec % 60}秒` : '';
      const rankings = h.rankings || [];
      const topPlayers = rankings.slice(0, 3).map((r, i) => {
        const medals = ['🥇', '🥈', '🥉'];
        return `${medals[i] || ''} ${escapeHtml(r.nickname || r.name || '?')}`;
      }).join('  ');
      return `
        <div class="history-item history-${h.game_type}">
          <div class="history-item-header">
            <span class="history-game-tag">${gameLabel}</span>
            <span class="history-time">${time}</span>
            ${duration ? `<span class="history-duration">⏱ ${duration}</span>` : ''}
          </div>
          <div class="history-winner">🏆 ${escapeHtml(h.winner_name || '未知')}</div>
          <div class="history-rankings">${topPlayers}</div>
        </div>
      `;
    }).join('');
  } catch (e) {
    container.innerHTML = '<div class="history-empty">加载失败</div>';
  }
}

// ========== 游戏列表渲染 ==========
function renderGamesList() {
  const container = document.getElementById('games-list');
  container.innerHTML = GAMES.map(game => `
    <div class="game-card" onclick="enterGame('${game.code}')">
      <div class="game-card-icon">${game.icon}</div>
      <div class="game-card-info">
        <div class="game-card-name">${game.name}</div>
        <div class="game-card-desc">${game.description}</div>
        <div class="game-card-meta">
          <span><span class="online-dot"></span>代号 ${game.code.toUpperCase()}</span>
        </div>
      </div>
      <div class="game-card-enter">
        <button class="btn btn-primary">进入 →</button>
      </div>
    </div>
  `).join('');
}

function enterGame(code) {
  window.location.href = `/${code}`;
}

// ========== 登录/注册逻辑 ==========
document.querySelectorAll('.login-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const mode = tab.dataset.mode;
    document.querySelectorAll('.login-form').forEach(f => f.style.display = 'none');
    const form = document.getElementById(`form-${mode}`);
    if (form) form.style.display = '';
  });
});

// 账号登录
document.getElementById('btn-account-login').addEventListener('click', async () => {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  if (!username || !password) { showLoginStatus('请输入用户名和密码'); return; }
  try {
    const res = await apiFetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (data.success) {
      showLoginStatus('登录成功，正在跳转...', 'success');
      setTimeout(() => location.reload(), 500);
    } else {
      showLoginStatus(data.message || '登录失败');
    }
  } catch (e) {
    showLoginStatus('网络错误');
  }
});

// 注册
document.getElementById('btn-register').addEventListener('click', async () => {
  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  const nickname = document.getElementById('reg-nickname').value.trim();
  const qq = document.getElementById('reg-qq').value.trim();
  if (!username || !password || !nickname) { showLoginStatus('用户名、密码和昵称为必填项'); return; }
  try {
    const res = await apiFetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, nickname, qq }),
    });
    const data = await res.json();
    if (data.success) {
      showLoginStatus('注册成功，正在跳转...', 'success');
      setTimeout(() => location.reload(), 500);
    } else {
      showLoginStatus(data.message || '注册失败');
    }
  } catch (e) {
    showLoginStatus('网络错误');
  }
});

// QQ头像预览（注册）
document.getElementById('reg-qq').addEventListener('input', updateAvatarPreview);

function updateAvatarPreview() {
  const qq = document.getElementById('reg-qq').value.trim();
  const preview = document.getElementById('avatar-preview');
  const img = document.getElementById('avatar-img');
  const name = document.getElementById('avatar-name');
  if (qq && /^\d{5,11}$/.test(qq)) {
    img.src = `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=100`;
    img.onerror = () => { preview.style.display = 'none'; };
    img.onload = () => { preview.style.display = 'flex'; name.textContent = '头像加载成功'; };
  } else {
    preview.style.display = 'none';
  }
}

// 游客登录
document.getElementById('btn-guest-login').addEventListener('click', async () => {
  const nickname = document.getElementById('guest-nickname').value.trim();
  const qq = document.getElementById('guest-qq').value.trim();
  if (!nickname) { showLoginStatus('请输入昵称'); return; }
  try {
    const res = await apiFetch('/api/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname, qq }),
    });
    const data = await res.json();
    if (data.success) {
      showLoginStatus('进入成功，正在跳转...', 'success');
      setTimeout(() => location.reload(), 500);
    } else {
      showLoginStatus(data.message || '进入失败');
    }
  } catch (e) {
    showLoginStatus('网络错误');
  }
});

function showLoginStatus(msg, type) {
  const el = document.getElementById('login-status');
  el.textContent = msg;
  el.className = 'login-status' + (type === 'success' ? ' success' : '');
}

// 退出登录
async function logout() {
  await apiFetch('/api/logout', { method: 'POST' });
  location.reload();
}

// ========== 侧边栏数据 ==========
async function loadFriendLinks() {
  try {
    const res = await apiFetch('/api/links');
    const links = await res.json();
    if (links.length === 0) return;
    const container = document.getElementById('hub-links-container');
    const list = document.getElementById('hub-links');
    list.innerHTML = links.map(link => `
      <a href="${escapeHtml(link.url)}" target="_blank" rel="noopener" class="hub-link-item">
        <span class="hub-link-name">${escapeHtml(link.name)}</span>
        ${link.description ? `<span class="hub-link-desc">${escapeHtml(link.description)}</span>` : ''}
      </a>
    `).join('');
    container.style.display = 'block';
  } catch (e) { console.error('loadFriendLinks error:', e); }
}

async function loadAds() {
  try {
    const res = await apiFetch('/api/ads?position=lobby');
    const ads = await res.json();
    if (ads.length === 0) return;
    const container = document.getElementById('hub-ads-container');
    const list = document.getElementById('hub-ads');
    list.innerHTML = ads.map(ad => `
      <div class="hub-ad-item">
        <div class="hub-ad-title">${escapeHtml(ad.title)}</div>
        ${ad.content ? `<div class="hub-ad-content">${escapeHtml(ad.content)}</div>` : ''}
        ${ad.link_url ? `<a href="${escapeHtml(ad.link_url)}" target="_blank" rel="noopener" class="hub-ad-link">查看详情 →</a>` : ''}
      </div>
    `).join('');
    container.style.display = 'block';
  } catch (e) { console.error('loadAds error:', e); }
}

async function loadOnlineStats() {
  try {
    const res = await apiFetch('/api/stats/online');
    const data = await res.json();
    document.getElementById('stat-total-online').textContent = data.totalOnline || 0;
    document.getElementById('stat-total-rooms').textContent = data.totalRooms || 0;
  } catch (e) { /* ignore */ }
}

// ========== 主题切换 ==========
document.getElementById('hub-theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
});

// ========== 工具函数 ==========
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 启动
init();
