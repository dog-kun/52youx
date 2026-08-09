// ========== UNO 前端逻辑 ==========

// 全局状态
let socket = connectSocket('/uno');
let state = null;
let mySocketId = null;
let currentUser = null; // { id, username, nickname, avatar, qq }
let theme = localStorage.getItem('theme') || 'dark';
let pendingRoomCode = null; // 从 URL 解析的待加入房间号

// 局部交互状态
let pendingWildCardId = null; // 等待选色的万能牌 id
let drawnCard = null; // 摸到并可出的牌（等待玩家决定出/过）
let prevWinnerId = null; // 用于检测游戏结束

// 卡牌符号映射
const CARD_SYMBOLS = {
  skip: '⊘',
  reverse: '⇄',
  draw2: '+2',
  wild: 'W',
  wild4: '+4',
};

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', () => {
  setupSocket();
  setupEvents();
  applyTheme();
  checkUrlRoom();
  checkAutoLogin();
  updateSoundButton();
});

// ========== URL 房间号解析 ==========
function checkUrlRoom() {
  const path = window.location.pathname;
  // 支持 /uno/ROOMCODE 格式
  const match = path.match(/^\/uno\/([A-Z0-9]{6})$/i);
  if (match) {
    pendingRoomCode = match[1].toUpperCase();
  }
}

// ========== 自动登录检查 ==========
async function checkAutoLogin() {
  try {
    const res = await apiFetch('/api/me');
    const data = await res.json();
    if (data.loggedIn) {
      currentUser = data.user;
      // 同步用户信息到 socket
      socket.emit('syncUser', {
        userId: data.user.id,
        username: data.user.username,
        nickname: data.user.nickname,
        avatar: data.user.avatar,
        qq: data.user.qq,
      });
      // 若 URL 带房间号，自动加入
      if (pendingRoomCode) {
        document.getElementById('room-code-input').value = pendingRoomCode;
        setTimeout(() => {
          socket.emit('joinRoom', { roomCode: pendingRoomCode });
          pendingRoomCode = null;
        }, 300);
      }
    } else {
      // 未登录，跳回主大厅
      window.location.href = '/';
    }
  } catch (e) {
    console.error('Auto login check failed:', e);
    window.location.href = '/';
  }
}

// ========== Socket 事件 ==========
function setupSocket() {
  socket.on('connect', () => { mySocketId = socket.id; });

  // 服务端从 cookie 恢复用户后推送
  socket.on('autoLogin', (data) => {
    currentUser = data.user;
    socket.emit('syncUser', {
      userId: data.user.id,
      username: data.user.username,
      nickname: data.user.nickname,
      avatar: data.user.avatar,
    });
    // 拉取完整用户信息
    apiFetch('/api/me').then(r => r.json()).then(d => {
      if (d.loggedIn) { currentUser = d.user; }
    }).catch(() => {});
  });

  // 状态更新：渲染全部
  socket.on('stateUpdate', (newState) => {
    state = newState;
    renderAll();
  });

  // 错误提示
  socket.on('error', (data) => {
    showToast(data.message, 'error');
    if (typeof Sounds !== 'undefined') Sounds.error();
  });

  // 房间创建成功
  socket.on('roomCreated', (data) => {
    document.getElementById('display-room-code').textContent = data.roomCode;
    document.getElementById('game-room-code').textContent = data.roomCode;
  });

  // 以观众身份加入
  socket.on('spectatorJoined', () => {
    showToast('你以观众身份加入', 'success');
  });

  // 摸牌结果：服务器返回摸到的牌及是否可出
  socket.on('drawResult', (data) => {
    if (data && data.canPlay && data.drewCard) {
      drawnCard = data.drewCard;
      showDrawChoiceModal(data.drewCard);
    }
  });

  // 聊天消息（通过 stateUpdate 渲染，此处仅占位）
  socket.on('chatMessage', () => {});
}

// ========== DOM 事件绑定 ==========
function setupEvents() {
  // 创建房间
  document.getElementById('btn-create').addEventListener('click', () => {
    const maxPlayers = parseInt(document.getElementById('max-players-select').value);
    socket.emit('createRoom', { maxPlayers });
  });

  // 加入房间
  document.getElementById('btn-join').addEventListener('click', () => {
    const code = document.getElementById('room-code-input').value.trim().toUpperCase();
    if (!code) { showToast('请输入房间号', 'error'); return; }
    socket.emit('joinRoom', { roomCode: code });
  });

  // 观众加入
  document.getElementById('btn-spectate').addEventListener('click', () => {
    const code = document.getElementById('room-code-input').value.trim().toUpperCase();
    if (!code) { showToast('请输入房间号', 'error'); return; }
    socket.emit('spectateRoom', { roomCode: code });
  });

  // 开始游戏
  document.getElementById('btn-start-game').addEventListener('click', () => {
    socket.emit('startGame');
  });

  // 复制房间号 / 链接
  document.getElementById('btn-copy-code').addEventListener('click', () => {
    const code = document.getElementById('display-room-code').textContent;
    navigator.clipboard.writeText(code).then(() => showToast('房间号已复制', 'success'));
  });
  document.getElementById('btn-copy-link').addEventListener('click', () => {
    const code = document.getElementById('display-room-code').textContent;
    const link = `${window.location.origin}/uno/${code}`;
    navigator.clipboard.writeText(link).then(() => showToast('链接已复制', 'success'));
  });

  // 离开房间（大厅等待区 / 游戏中）
  document.getElementById('btn-leave-lobby').addEventListener('click', () => {
    socket.emit('leaveRoom');
  });
  document.getElementById('btn-leave-game').addEventListener('click', () => {
    if (confirm('确定离开房间吗？')) {
      socket.emit('leaveRoom');
    }
  });

  // 游戏结束返回
  document.getElementById('btn-back-lobby').addEventListener('click', () => {
    document.getElementById('gameover-modal').style.display = 'none';
    socket.emit('leaveRoom');
  });

  // 音效开关
  document.getElementById('btn-sound').addEventListener('click', () => {
    const enabled = toggleSound();
    updateSoundButton();
    showToast(enabled ? '音效已开启' : '音效已关闭', '');
  });

  // 主题切换
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  // UNO 按钮
  document.getElementById('btn-uno').addEventListener('click', () => {
    socket.emit('callUno');
  });

  // 摸牌堆点击
  document.getElementById('uno-deck').addEventListener('click', () => {
    if (!state) return;
    if (state.currentPlayerId === mySocketId && state.gameState === 'playing' && !state.pendingColorChoice) {
      socket.emit('drawCard');
    } else if (state.currentPlayerId === mySocketId) {
      showToast('请先完成当前操作', 'error');
    } else {
      showToast('不是你的回合', 'error');
    }
  });

  // 颜色选择
  document.querySelectorAll('.uno-color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color;
      document.getElementById('color-picker-modal').style.display = 'none';
      if (pendingWildCardId !== null) {
        socket.emit('playCard', { cardId: pendingWildCardId, color });
        pendingWildCardId = null;
      }
    });
  });
  document.getElementById('btn-cancel-color').addEventListener('click', () => {
    document.getElementById('color-picker-modal').style.display = 'none';
    pendingWildCardId = null;
  });

  // 摸牌后选择：打出 / 过
  document.getElementById('btn-play-drawn').addEventListener('click', () => {
    if (!drawnCard) return;
    const card = drawnCard;
    document.getElementById('draw-choice-modal').style.display = 'none';
    drawnCard = null;
    if (card.color === 'wild') {
      // 万能牌需先选色
      pendingWildCardId = card.id;
      document.getElementById('color-picker-modal').style.display = 'flex';
    } else {
      socket.emit('playCard', { cardId: card.id, color: null });
    }
  });
  document.getElementById('btn-pass-drawn').addEventListener('click', () => {
    document.getElementById('draw-choice-modal').style.display = 'none';
    drawnCard = null;
    socket.emit('passAfterDraw');
  });

  // 聊天发送
  document.getElementById('btn-send-chat').addEventListener('click', sendChat);
  document.getElementById('uno-chat-input').addEventListener('keypress', e => {
    if (e.key === 'Enter') sendChat();
  });

  // 面板折叠
  document.getElementById('btn-toggle-chat').addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = document.getElementById('uno-chat-panel');
    panel.classList.toggle('collapsed');
    document.getElementById('btn-toggle-chat').textContent = panel.classList.contains('collapsed') ? '+' : '−';
  });
  document.getElementById('btn-toggle-log').addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = document.getElementById('uno-log-panel');
    panel.classList.toggle('collapsed');
    document.getElementById('btn-toggle-log').textContent = panel.classList.contains('collapsed') ? '+' : '−';
  });

  // 整个侧边面板显示/隐藏
  document.getElementById('btn-side-toggle').addEventListener('click', () => {
    const panels = document.getElementById('uno-side-panels');
    panels.classList.toggle('hidden');
    document.getElementById('btn-side-toggle').textContent = panels.classList.contains('hidden') ? '📋' : '✕';
  });

  // 房间号输入回车加入
  document.getElementById('room-code-input').addEventListener('keypress', e => {
    if (e.key === 'Enter') document.getElementById('btn-join').click();
  });
}

// ========== 聊天发送 ==========
function sendChat() {
  const input = document.getElementById('uno-chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  socket.emit('chat', { message: msg });
  input.value = '';
}

// ========== 视图管理 ==========
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
}

// ========== 主渲染调度 ==========
function renderAll() {
  if (!state) return;
  if (state.gameState === 'waiting') {
    showView('lobby');
    renderLobby();
  } else {
    showView('game');
    renderGame();
  }
}

// ========== 大厅 / 等待区渲染 ==========
function renderLobby() {
  const me = state.players.find(p => p.id === mySocketId);
  const waiting = document.getElementById('room-waiting');
  const top = document.querySelector('.uno-lobby-top');

  if (!me) {
    // 观众或未在房间，显示创建/加入面板
    waiting.style.display = 'none';
    top.style.display = 'flex';
    return;
  }

  // 在等待房间中
  top.style.display = 'none';
  waiting.style.display = 'block';
  document.getElementById('display-room-code').textContent = state.roomCode;
  document.getElementById('player-count').textContent = state.players.length;
  document.getElementById('max-player-count').textContent = state.maxPlayers;

  // 玩家列表
  const list = document.getElementById('lobby-players');
  list.innerHTML = '';
  for (const p of state.players) {
    const card = document.createElement('div');
    card.className = 'lobby-player-card';
    card.innerHTML = `
      ${p.avatar
        ? `<img src="${p.avatar}" alt="" onerror="this.style.display='none'">`
        : `<div style="width:32px;height:32px;border-radius:50%;background:${p.color}"></div>`}
      <div>
        <div>${escapeHtml(p.nickname)}</div>
        ${p.isHost ? '<div class="host-badge">👑 房主</div>' : ''}
      </div>
    `;
    list.appendChild(card);
  }

  // 开始按钮：仅房主且 >=2 人可见
  const startBtn = document.getElementById('btn-start-game');
  startBtn.style.display = (me.isHost && state.players.length >= 2) ? '' : 'none';
}

// ========== 游戏视图渲染 ==========
function renderGame() {
  document.getElementById('game-room-code').textContent = state.roomCode;
  renderTurnInfo();
  renderOpponents();
  renderCenterArea();
  renderActionPrompt();
  renderHand();
  renderLog();
  renderChat();
  renderGameOver();
  updateUnoButton();
}

// ========== 回合信息（头部） ==========
function renderTurnInfo() {
  const el = document.getElementById('uno-turn-info');
  if (state.gameState === 'ended') { el.textContent = '游戏结束'; return; }
  if (state.gameState === 'waiting') { el.textContent = '等待开始'; return; }
  const cur = state.players[state.currentPlayerIndex];
  if (!cur) { el.textContent = ''; return; }
  const isMyTurn = state.currentPlayerId === mySocketId;
  let info = isMyTurn ? '轮到你出牌' : `${cur.nickname} 的回合`;
  if (state.drawStack > 0) info += ` · 累计+${state.drawStack}`;
  el.textContent = info;
}

// ========== 对手渲染 ==========
function renderOpponents() {
  const container = document.getElementById('opponents-area');
  container.innerHTML = '';
  const opponents = state.players.filter(p => p.id !== mySocketId);

  for (const p of opponents) {
    const el = document.createElement('div');
    el.className = 'uno-opponent';
    if (p.id === state.currentPlayerId && state.gameState === 'playing') el.classList.add('current');
    if (p.disconnected) el.classList.add('disconnected');

    // 显示最多 7 张牌背
    const showCount = Math.min(p.handCount, 7);
    let cardsHtml = '';
    for (let i = 0; i < showCount; i++) {
      cardsHtml += '<div class="uno-card uno-card-back"><div class="uno-back-logo">UNO</div></div>';
    }

    el.innerHTML = `
      <div class="uno-opponent-info">
        ${p.avatar
          ? `<img src="${p.avatar}" class="uno-opponent-avatar" alt="" onerror="this.style.display='none';this.classList.add('placeholder')">`
          : `<div class="uno-opponent-avatar placeholder" style="background:${p.color}"></div>`}
        <span class="uno-opponent-name">${escapeHtml(p.nickname)}</span>
        ${p.saidUno ? '<span class="uno-opponent-uno-badge">UNO</span>' : ''}
      </div>
      <div class="uno-opponent-cards">${cardsHtml}</div>
      <div class="uno-opponent-count">${p.handCount} 张${p.isHost ? ' · 👑' : ''}</div>
    `;
    container.appendChild(el);
  }
}

// ========== 中央区域渲染 ==========
function renderCenterArea() {
  // 弃牌堆顶牌
  const discard = document.getElementById('uno-discard');
  discard.innerHTML = '';
  const top = state.discardPileTop;
  if (top) {
    const card = document.createElement('div');
    card.className = 'uno-card ' + top.color;
    card.innerHTML = buildCardHTML(top);
    discard.appendChild(card);
  }

  // 牌堆剩余
  document.getElementById('deck-count').textContent = state.deckCount + ' 张';

  // 当前颜色指示
  const colorInd = document.getElementById('color-indicator');
  colorInd.className = 'uno-color-indicator ' + (state.currentColor || '');
  colorInd.title = '当前颜色：' + colorNameZh(state.currentColor);

  // 方向指示
  const dir = document.getElementById('direction-indicator');
  dir.textContent = state.direction === 1 ? '↻' : '↺';
  dir.classList.toggle('reverse', state.direction === -1);
  dir.title = state.direction === 1 ? '顺时针' : '逆时针';

  // 累计罚牌
  const ds = document.getElementById('draw-stack-indicator');
  if (state.drawStack > 0) {
    ds.style.display = '';
    ds.textContent = '+' + state.drawStack;
  } else {
    ds.style.display = 'none';
  }

  // 牌堆可点击性
  const deck = document.getElementById('uno-deck');
  const isMyTurn = state.currentPlayerId === mySocketId && state.gameState === 'playing' && !state.pendingColorChoice;
  deck.style.cursor = isMyTurn ? 'pointer' : 'default';
  deck.style.opacity = isMyTurn ? '1' : '0.55';
}

// ========== 操作提示 ==========
function renderActionPrompt() {
  const el = document.getElementById('uno-action-prompt');
  const me = state.players.find(p => p.id === mySocketId);
  if (!me) { el.textContent = ''; return; }

  const isMyTurn = state.currentPlayerId === mySocketId && state.gameState === 'playing';
  let text = '';
  if (state.gameState === 'ended') {
    text = '游戏已结束';
  } else if (!isMyTurn) {
    const cur = state.players[state.currentPlayerIndex];
    text = cur ? `等待 ${cur.nickname} 出牌...` : '';
  } else if (state.pendingColorChoice) {
    text = '请选择颜色';
  } else if (state.drawStack > 0) {
    text = `累计 +${state.drawStack}：出 +2 连锁或摸牌`;
  } else {
    text = '出牌或点击牌堆摸牌';
  }
  el.textContent = text;
}

// ========== 手牌渲染 ==========
function renderHand() {
  const container = document.getElementById('uno-hand');
  container.innerHTML = '';
  const me = state.players.find(p => p.id === mySocketId);
  const info = document.getElementById('uno-hand-info');

  if (!me || !me.hand) {
    info.textContent = me ? `你有 ${me.handCount} 张牌` : '';
    return;
  }

  const isMyTurn = state.currentPlayerId === mySocketId && state.gameState === 'playing';

  for (const card of me.hand) {
    const el = document.createElement('div');
    el.className = 'uno-card ' + card.color;
    el.dataset.cardId = card.id;

    if (isMyTurn && !state.pendingColorChoice) {
      const playable = isCardPlayable(card);
      if (playable) {
        el.classList.add('playable', 'clickable');
      } else {
        el.classList.add('unplayable');
      }
    } else {
      el.classList.add('unplayable');
    }

    el.innerHTML = buildCardHTML(card);
    el.addEventListener('click', () => handleCardClick(card));
    container.appendChild(el);
  }

  // 手牌区提示
  if (isMyTurn) {
    if (state.pendingColorChoice) {
      info.textContent = '请选择颜色';
    } else if (state.drawStack > 0) {
      info.textContent = `累计罚牌 +${state.drawStack}，出 +2 连锁或摸牌`;
    } else {
      info.textContent = `你的回合 · ${me.hand.length} 张牌`;
    }
  } else if (state.gameState === 'playing') {
    const cur = state.players[state.currentPlayerIndex];
    info.textContent = cur ? `${cur.nickname} 的回合 · 你 ${me.hand.length} 张` : '';
  } else {
    info.textContent = `${me.hand.length} 张牌`;
  }
}

// ========== 卡牌点击处理 ==========
function handleCardClick(card) {
  if (!state || state.gameState !== 'playing') {
    showToast('游戏未开始', 'error');
    return;
  }
  if (state.currentPlayerId !== mySocketId) {
    showToast('不是你的回合', 'error');
    return;
  }
  if (state.pendingColorChoice) {
    showToast('请先选择颜色', 'error');
    return;
  }
  if (!isCardPlayable(card)) {
    showToast('不能出这张牌', 'error');
    return;
  }

  // 万能牌先选色
  if (card.color === 'wild') {
    pendingWildCardId = card.id;
    document.getElementById('color-picker-modal').style.display = 'flex';
    return;
  }

  socket.emit('playCard', { cardId: card.id, color: null });
}

// ========== 摸牌选择弹窗 ==========
function showDrawChoiceModal(card) {
  const container = document.getElementById('draw-choice-card');
  container.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'uno-card ' + card.color;
  el.innerHTML = buildCardHTML(card);
  container.appendChild(el);
  document.getElementById('draw-choice-modal').style.display = 'flex';
}

// ========== 出牌可行性检查（客户端镜像服务端逻辑） ==========
function isCardPlayable(card) {
  if (!state || state.gameState !== 'playing') return false;
  if (state.currentPlayerId !== mySocketId) return false;
  if (state.pendingColorChoice) return false;

  // 累计罚牌时只能出 +2 连锁
  if (state.drawStack > 0) {
    return card.type === 'draw2';
  }

  // 万能牌随时可出
  if (card.color === 'wild') return true;

  // 同色
  if (card.color === state.currentColor) return true;

  // 同数字 / 同类型
  const top = state.discardPileTop;
  if (!top) return false;
  if (card.type === 'number' && top.type === 'number' && card.value === top.value) return true;
  if (card.type !== 'number' && card.type === top.type) return true;

  return false;
}

// ========== UNO 按钮状态 ==========
function updateUnoButton() {
  const btn = document.getElementById('btn-uno');
  if (!state || state.gameState !== 'playing') { btn.disabled = true; return; }
  const me = state.players.find(p => p.id === mySocketId);
  // 剩 1 张且未喊时可用
  const canCall = me && me.hand && me.hand.length === 1 && !me.saidUno;
  btn.disabled = !canCall;
}

// ========== 日志渲染 ==========
function renderLog() {
  const log = document.getElementById('uno-game-log');
  const wasAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 50;
  log.innerHTML = '';
  const logs = state.logs || [];
  for (let i = logs.length - 1; i >= 0 && i >= logs.length - 60; i--) {
    const entry = logs[i];
    const div = document.createElement('div');
    div.className = 'uno-log-entry';
    if (i === logs.length - 1) div.classList.add('highlight');
    const time = new Date(entry.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    div.innerHTML = `<span class="log-time">${time}</span>${escapeHtml(entry.msg)}`;
    log.appendChild(div);
  }
  if (wasAtBottom) log.scrollTop = log.scrollHeight;
}

// ========== 聊天渲染 ==========
function renderChat() {
  const container = document.getElementById('uno-chat-messages');
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
  container.innerHTML = '';
  for (const msg of (state.chatMessages || [])) {
    const div = document.createElement('div');
    div.className = 'uno-chat-msg';
    if (msg.playerId === mySocketId) div.classList.add('me');
    div.innerHTML = `
      ${msg.avatar
        ? `<img src="${msg.avatar}" class="uc-avatar" alt="" onerror="this.style.display='none';this.classList.add('placeholder')">`
        : `<div class="uc-avatar placeholder"></div>`}
      <div>
        <div class="uc-name">${escapeHtml(msg.nickname)}</div>
        <div class="uc-bubble">${escapeHtml(msg.message)}</div>
      </div>
    `;
    container.appendChild(div);
  }
  if (wasAtBottom) container.scrollTop = container.scrollHeight;
}

// ========== 游戏结束弹窗 ==========
function renderGameOver() {
  if (!state.winner) {
    document.getElementById('gameover-modal').style.display = 'none';
    prevWinnerId = null;
    return;
  }
  if (state.winner.id === prevWinnerId) return;
  prevWinnerId = state.winner.id;

  if (typeof Sounds !== 'undefined') Sounds.win();
  const modal = document.getElementById('gameover-modal');
  document.getElementById('gameover-title').textContent = '游戏结束！';
  document.getElementById('gameover-winner').innerHTML = `🏆 冠军: ${escapeHtml(state.winner.nickname)}`;

  const rankings = state.rankings ||
    [...state.players].sort((a, b) => (a.handCount || 0) - (b.handCount || 0));
  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  const rankHtml = rankings.map((r, i) => {
    const medal = medals[i] || `${i + 1}.`;
    const avatar = r.avatar
      ? `<img src="${r.avatar}" alt="" onerror="this.style.display='none'">`
      : `<div style="width:32px;height:32px;border-radius:50%;background:#666"></div>`;
    return `
      <div class="ranking-item">
        <span class="rank">${medal}</span>
        ${avatar}
        <span class="r-name">${escapeHtml(r.nickname)}</span>
        <span class="r-cards">剩余 ${r.handCount} 张</span>
      </div>
    `;
  }).join('');
  document.getElementById('gameover-rankings').innerHTML = rankHtml;
  modal.style.display = 'flex';
}

// ========== 卡牌 HTML 构造 ==========
function buildCardHTML(card) {
  const symbol = getCardSymbol(card);
  const isWild = card.color === 'wild';
  let center;
  if (isWild) {
    center = `<div class="uno-wild-circle"></div>`;
  } else {
    center = `<div class="uno-card-oval"></div><div class="uno-card-center">${escapeHtml(symbol)}</div>`;
  }
  return `
    <div class="uno-card-corner tl">${escapeHtml(symbol)}</div>
    ${center}
    <div class="uno-card-corner br">${escapeHtml(symbol)}</div>
  `;
}

function getCardSymbol(card) {
  if (card.type === 'number') return String(card.value);
  return CARD_SYMBOLS[card.type] || '?';
}

// ========== 颜色中文名 ==========
function colorNameZh(color) {
  return ({ red: '红色', yellow: '黄色', green: '绿色', blue: '蓝色', wild: '万能' })[color] || color || '未定';
}

// ========== 主题 ==========
function toggleTheme() {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', theme);
  applyTheme();
}
function applyTheme() {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

// ========== 音效按钮 ==========
function updateSoundButton() {
  const btn = document.getElementById('btn-sound');
  if (btn) btn.textContent = isSoundEnabled() ? '🔊' : '🔇';
}

// ========== 工具函数 ==========
function showToast(message, type = '') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
  if (type !== 'error' && typeof Sounds !== 'undefined') Sounds.notify();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
