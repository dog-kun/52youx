// ========== 全局状态 ==========
let socket = connectSocket('/monopoly');
let state = null;
let mySocketId = null;
let currentUser = null; // { id, username, nickname, avatar, qq }
let theme = localStorage.getItem('theme') || 'dark';
let prevCardId = null;
let prevRoll = null;
let prevWinner = null;
let auctionEndAt = null;
let auctionTimerInterval = null;
let pendingRoomCode = null;
let lobbyRefreshInterval = null;

// 动画状态
let animState = {
  active: false,
  skipRequested: false,
  playerPositions: {}, // playerId -> current animated position
};

const DICE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const COLOR_HEX = {
  brown: '#8B4513', lightblue: '#87CEEB', pink: '#E040FB', orange: '#FF9800',
  red: '#F44336', yellow: '#FFD600', green: '#4CAF50', darkblue: '#1A237E', station: '#607D8B'
};
const CELL_ICONS = {
  corner_go: '🏁', corner_jail: '🔒', corner_park: '🅿️', corner_rest: '🚔',
  chance: '❓', community: '🎁', tax: '💰', station: '🚂', treasure: '💎'
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

function checkUrlRoom() {
  const path = window.location.pathname;
  // 支持 /dfw/ROOMCODE 格式
  const match = path.match(/^\/dfw\/([A-Z0-9]{6})$/i);
  if (match) {
    pendingRoomCode = match[1].toUpperCase();
  }
}

// 检查 cookie 自动登录
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
      showView('lobby');
      updateLobbyUserBar(data.stats);
      refreshLobbyRooms();
      loadFriendLinks();
      startLobbyAutoRefresh();
      if (pendingRoomCode) {
        document.getElementById('room-code-input').value = pendingRoomCode;
        setTimeout(() => {
          socket.emit('joinRoom', { roomCode: pendingRoomCode });
          pendingRoomCode = null;
        }, 300);
      }
    } else {
      // 未登录，跳转到主大厅
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

  socket.on('autoLogin', (data) => {
    currentUser = data.user;
    // 同步用户信息到 socket
    socket.emit('syncUser', {
      userId: data.user.id,
      username: data.user.username,
      nickname: data.user.nickname,
      avatar: data.user.avatar,
    });
    showView('lobby');
    refreshLobbyRooms();
    loadFriendLinks();
    startLobbyAutoRefresh();
    // 获取完整用户信息（含stats和is_admin）
    apiFetch('/api/me').then(r => r.json()).then(d => {
      if (d.loggedIn) { currentUser = d.user; updateLobbyUserBar(d.stats); }
    });
  });

  socket.on('loginSuccess', (data) => {
    showView('lobby');
    refreshLobbyRooms();
    loadFriendLinks();
    startLobbyAutoRefresh();
    if (pendingRoomCode) {
      document.getElementById('room-code-input').value = pendingRoomCode;
      setTimeout(() => {
        socket.emit('joinRoom', { roomCode: pendingRoomCode });
        pendingRoomCode = null;
      }, 300);
    }
  });

  socket.on('roomCreated', (data) => {
    document.getElementById('display-room-code').textContent = data.roomCode;
    document.getElementById('game-room-code').textContent = data.roomCode;
  });

  socket.on('spectatorJoined', () => {
    showToast('你以观众身份加入', 'success');
  });

  socket.on('lobbyList', (list) => {
    renderOngoingGames(list);
  });

  socket.on('stateUpdate', (newState) => {
    handleStateUpdate(newState);
  });

  socket.on('chatMessage', (msg) => {
    // 从 state 更新中渲染，这里仅触发滚动
  });

  socket.on('error', (data) => {
    showToast(data.message, 'error');
    Sounds.error();
  });
}

// ========== 状态更新处理（含动画） ==========
function handleStateUpdate(newState) {
  const oldState = state;
  state = newState;

  // 检测游戏事件并播放音效
  if (oldState) {
    detectAndPlaySounds(oldState, newState);
  }

  // 检测玩家移动并触发动画
  if (oldState && oldState.players && newState.players) {
    const mover = detectMovement(oldState, newState);
    if (mover && !animState.active) {
      animateMovement(mover, oldState, newState);
      return; // 动画完成后再渲染
    }
  }

  renderAll();
}

// 通过对比新旧状态检测游戏事件并播放音效
function detectAndPlaySounds(oldState, newState) {
  // 检测新日志中的事件
  if (oldState.logs && newState.logs) {
    const newLogs = newState.logs.slice(oldState.logs.length);
    for (const log of newLogs) {
      const msg = log.message || '';
      if (msg.includes('购买了')) Sounds.buy();
      else if (msg.includes('支付租金') || msg.includes('缴纳')) Sounds.pay();
      else if (msg.includes('监狱') || msg.includes('逮捕') || msg.includes('入狱')) Sounds.jail();
      else if (msg.includes('破产')) Sounds.bankrupt();
      else if (msg.includes('建造了') || msg.includes('建房')) Sounds.build();
      else if (msg.includes('交易达成')) Sounds.trade();
      else if (msg.includes('拍卖开始')) Sounds.auction();
      else if (msg.includes('获得') && msg.includes('起点')) Sounds.go();
      else if (msg.includes('获胜')) Sounds.win();
    }
  }
}

// 检测哪个玩家移动了
function detectMovement(oldState, newState) {
  for (const newP of newState.players) {
    const oldP = oldState.players.find(p => p.id === newP.id);
    if (oldP && oldP.position !== newP.position && !newP.bankrupt) {
      return {
        playerId: newP.id,
        fromPos: oldP.position,
        toPos: newP.position,
        player: newP,
      };
    }
  }
  return null;
}

// 玩家移动动画
async function animateMovement(mover, oldState, newState) {
  animState.active = true;
  animState.skipRequested = false;

  const skipArea = document.getElementById('anim-skip-area');
  skipArea.style.display = 'block';

  let currentPos = mover.fromPos;
  const targetPos = mover.toPos;

  // 判断前进还是后退
  let isBackward = false;
  let steps;
  if (targetPos < currentPos) {
    // 可能是经过起点（前进）或后退
    const forwardSteps = (40 - currentPos) + targetPos;
    const backwardSteps = currentPos - targetPos;
    if (backwardSteps <= forwardSteps && backwardSteps <= 12) {
      isBackward = true;
      steps = backwardSteps;
    } else {
      steps = forwardSteps;
    }
  } else {
    steps = targetPos - currentPos;
  }

  // 逐步移动
  for (let i = 0; i < steps; i++) {
    if (animState.skipRequested) break;

    if (isBackward) {
      currentPos--;
      if (currentPos < 1) currentPos = 40;
    } else {
      currentPos++;
      if (currentPos > 40) {
        currentPos = 1;
        // 经过起点音效
        Sounds.go();
      }
    }

    // 更新动画位置
    animState.playerPositions[mover.playerId] = currentPos;
    Sounds.step();

    // 临时渲染棋盘（使用动画位置）
    renderBoardWithAnim();

    await sleep(animState.skipRequested ? 0 : 250);
  }

  skipArea.style.display = 'none';
  animState.active = false;
  animState.playerPositions = {};

  // 动画完成后正式渲染
  renderAll();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 使用动画位置渲染棋盘
function renderBoardWithAnim() {
  if (!state) return;
  const board = document.getElementById('board');
  board.innerHTML = '';

  for (const space of state.board) {
    const prop = state.properties[space.id];
    const pos = getGridPosition(space.id);
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.style.gridRow = pos.row + 1;
    cell.style.gridColumn = pos.col + 1;
    cell.dataset.spaceId = space.id;

    const isCorner = space.type.startsWith('corner');
    if (isCorner) cell.classList.add('cell-corner');

    let html = '';
    if (isCorner) {
      const bg = { corner_go: '#2e7d32', corner_jail: '#e65100', corner_park: '#1565c0', corner_rest: '#b71c1c' };
      cell.style.background = bg[space.type] || '';
      html = `<div class="corner-icon">${CELL_ICONS[space.type] || ''}</div>`;
      html += `<div class="corner-name">${space.name}</div>`;
    } else if (space.type === 'property') {
      html = `<div class="color-bar" style="background:${COLOR_HEX[space.color] || '#888'}"></div>`;
      html += `<div class="cell-name">${space.name}</div>`;
      html += `<div class="cell-price">$${space.price}</div>`;
      if (prop && prop.houses > 0) {
        html += '<div class="houses">';
        if (prop.houses === 5) html += '<span class="hotel-icon">🏨</span>';
        else { for (let i = 0; i < prop.houses; i++) html += '<span class="house-icon">🏠</span>'; }
        html += '</div>';
      }
    } else if (space.type === 'station') {
      html = `<div class="color-bar" style="background:${COLOR_HEX.station}"></div>`;
      html += `<div class="cell-name">${CELL_ICONS.station} ${space.name}</div>`;
      html += `<div class="cell-price">$${space.price}</div>`;
    } else if (space.type === 'treasure') {
      html = `<div class="color-bar" style="background:#FFD700"></div>`;
      html += `<div class="cell-name">${CELL_ICONS.treasure} ${space.name}</div>`;
      html += `<div class="cell-price">$${space.price}</div>`;
    } else {
      html = `<div style="font-size:16px;margin-top:4px">${CELL_ICONS[space.type] || ''}</div>`;
      html += `<div class="cell-name">${space.name}</div>`;
    }
    cell.innerHTML = html;

    // 所有者颜色
    if (prop && prop.ownerId) {
      const owner = state.players.find(p => p.id === prop.ownerId);
      if (owner) {
        if (!isCorner) cell.style.background = owner.color + '33';
        const border = document.createElement('div');
        border.className = 'cell-owner-border';
        border.style.borderColor = owner.color;
        cell.appendChild(border);
      }
      if (prop.mortgaged) cell.classList.add('cell-mortgaged');
    }

    // 玩家棋子（使用动画位置）
    const tokensHere = state.players.filter(p => {
      if (p.bankrupt) return false;
      const animPos = animState.playerPositions[p.id];
      const actualPos = animPos !== undefined ? animPos : p.position;
      return actualPos === space.id;
    });
    if (tokensHere.length > 0) {
      const tokensDiv = document.createElement('div');
      tokensDiv.className = 'tokens';
      for (const p of tokensHere) {
        const token = document.createElement('div');
        token.className = 'token';
        if (p.id === state.currentPlayerId) token.classList.add('current');
        token.style.background = p.color;
        tokensDiv.appendChild(token);
      }
      cell.appendChild(tokensDiv);
    }

    cell.addEventListener('click', () => showPropertyDetail(space.id));
    board.appendChild(cell);
  }
}

// ========== DOM 事件 ==========
function setupEvents() {
  // 退出登录
  document.getElementById('btn-logout').addEventListener('click', handleLogout);

  // 大厅
  document.getElementById('btn-create').addEventListener('click', handleCreateRoom);
  document.getElementById('btn-join').addEventListener('click', () => {
    const code = document.getElementById('room-code-input').value.trim().toUpperCase();
    if (!code) { showToast('请输入房间号', 'error'); return; }
    socket.emit('joinRoom', { roomCode: code });
  });
  document.getElementById('btn-refresh-rooms').addEventListener('click', refreshLobbyRooms);
  document.getElementById('btn-start-game').addEventListener('click', () => socket.emit('startGame'));
  document.getElementById('btn-copy-code').addEventListener('click', () => {
    const code = document.getElementById('display-room-code').textContent;
    navigator.clipboard.writeText(code).then(() => showToast('房间号已复制', 'success'));
  });
  document.getElementById('btn-copy-link').addEventListener('click', () => {
    const code = document.getElementById('display-room-code').textContent;
    const link = `${window.location.origin}/dfw/${code}`;
    navigator.clipboard.writeText(link).then(() => showToast('链接已复制', 'success'));
  });
  document.getElementById('btn-leave-lobby').addEventListener('click', () => {
    socket.emit('leaveRoom');
    document.getElementById('room-waiting').style.display = 'none';
    document.querySelector('.lobby-page').style.display = 'flex';
    refreshLobbyRooms();
  });
  document.getElementById('btn-lobby-history').addEventListener('click', () => {
    // 切换到历史标签页
    switchLobbySection('history');
  });

  // 大厅标签页切换（创建/加入）
  document.querySelectorAll('.lobby-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.lobby-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.lobby-tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById('lobby-tab-' + tab.dataset.lobbyTab).classList.add('active');
    });
  });

  // 大厅区域标签切换（当前对局/历史对局）
  document.querySelectorAll('.section-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchLobbySection(tab.dataset.section);
    });
  });

  // 游戏
  document.getElementById('btn-sound').addEventListener('click', () => {
    const enabled = toggleSound();
    updateSoundButton();
    showToast(enabled ? '音效已开启' : '音效已关闭', '');
  });
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);
  document.getElementById('btn-history').addEventListener('click', () => showHistoryModal());
  document.getElementById('btn-surrender').addEventListener('click', () => {
    if (confirm('确定要认输吗？认输后资产归银行，无法撤销。')) {
      socket.emit('surrender');
    }
  });
  document.getElementById('btn-leave-game').addEventListener('click', () => {
    if (confirm('确定离开房间吗？')) {
      socket.emit('leaveRoom');
      showView('lobby');
      document.getElementById('room-waiting').style.display = 'none';
      document.querySelector('.lobby-page').style.display = 'flex';
      refreshLobbyRooms();
    }
  });

  // 动画跳过
  document.getElementById('btn-skip-anim').addEventListener('click', () => {
    animState.skipRequested = true;
  });

  // 标签页
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // 聊天
  document.getElementById('btn-send-chat').addEventListener('click', sendChat);
  document.getElementById('chat-input').addEventListener('keypress', e => {
    if (e.key === 'Enter') sendChat();
  });
  document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('chat', { message: btn.dataset.msg });
    });
  });

  // 拍卖
  document.getElementById('btn-bid').addEventListener('click', placeBid);
  document.getElementById('bid-input').addEventListener('keypress', e => {
    if (e.key === 'Enter') placeBid();
  });
  document.getElementById('bid-input').addEventListener('input', () => updateBidDisplay());
  document.getElementById('bid-slider').addEventListener('input', () => {
    document.getElementById('bid-input').value = document.getElementById('bid-slider').value;
    updateBidDisplay();
  });
  document.querySelectorAll('.quick-bid').forEach(btn => {
    btn.addEventListener('click', () => handleQuickBid(btn));
  });
  document.querySelectorAll('.tune-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById('bid-input');
      const current = parseInt(input.value) || 0;
      const next = Math.max(0, current + parseInt(btn.dataset.add));
      input.value = next;
      syncSlider();
      updateBidDisplay();
    });
  });

  // 折叠标签
  document.getElementById('btn-collapse-tabs').addEventListener('click', (e) => {
    const container = document.getElementById('tab-container');
    container.classList.toggle('collapsed');
    e.target.textContent = container.classList.contains('collapsed') ? '展开' : '收起';
  });

  // 侧边栏收起/展开（浮动面板）
  document.getElementById('btn-minimize-sidebar').addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('hidden');
    document.getElementById('btn-restore-sidebar').style.display = 'flex';
  });
  document.getElementById('btn-restore-sidebar').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('hidden');
    document.getElementById('btn-restore-sidebar').style.display = 'none';
  });

  // 交易
  document.getElementById('btn-trade-send').addEventListener('click', sendTradeOffer);
  document.getElementById('btn-trade-accept').addEventListener('click', () => {
    socket.emit('respondTrade', { accept: true });
    Sounds.trade();
  });
  document.getElementById('btn-trade-decline').addEventListener('click', () => {
    socket.emit('respondTrade', { accept: false });
    document.getElementById('trade-modal').style.display = 'none';
  });
  document.getElementById('btn-trade-cancel').addEventListener('click', () => {
    socket.emit('cancelTrade');
    document.getElementById('trade-modal').style.display = 'none';
    tradeTargetId = null;
  });

  // 弹窗关闭
  document.getElementById('btn-close-card').addEventListener('click', () => hideModal('card-modal'));
  document.getElementById('btn-close-property').addEventListener('click', () => hideModal('property-modal'));
  document.getElementById('btn-close-history').addEventListener('click', () => hideModal('history-modal'));
  document.getElementById('btn-history-back').addEventListener('click', () => {
    document.getElementById('history-detail').style.display = 'none';
    document.getElementById('history-list').style.display = '';
  });
  document.getElementById('btn-view-history').addEventListener('click', () => {
    hideModal('gameover-modal');
    showHistoryModal();
  });
  document.getElementById('btn-back-lobby').addEventListener('click', () => {
    hideModal('gameover-modal');
    socket.emit('leaveRoom');
    showView('lobby');
    document.getElementById('room-waiting').style.display = 'none';
    document.querySelector('.lobby-page').style.display = 'flex';
    refreshLobbyRooms();
  });
}

async function handleLogout() {
  await apiFetch('/api/logout', { method: 'POST' });
  currentUser = null;
  window.location.href = '/';
}

function updateLobbyUserBar(stats) {
  const bar = document.getElementById('lobby-user-info');
  if (!currentUser) { bar.innerHTML = ''; return; }
  let html = '';
  if (currentUser.avatar) {
    html += `<img src="${currentUser.avatar}" class="lobby-avatar" alt="" onerror="this.style.display='none'">`;
  }
  html += `<div><div class="lobby-username">${escapeHtml(currentUser.nickname)}`;
  if (currentUser.is_admin) {
    html += ` <a href="/admin" class="admin-link" style="font-size:12px;color:var(--accent-yellow);text-decoration:none;margin-left:8px;">⚙️ 管理后台</a>`;
  }
  html += `</div>`;
  if (stats) {
    const winRate = stats.total_games > 0 ? Math.round(stats.wins / stats.total_games * 100) : 0;
    html += `<div class="lobby-stats">胜${stats.wins} 负${stats.losses} 场${stats.total_games} 胜率${winRate}%</div>`;
  } else {
    html += `<div class="lobby-stats">游客模式</div>`;
  }
  html += '</div>';
  bar.innerHTML = html;
}

// ========== 大厅对局列表 ==========
async function refreshLobbyRooms() {
  try {
    const res = await apiFetch('/api/rooms');
    const data = await res.json();
    // /api/rooms 返回 { monopoly: [...], uno: [...] }，只取大富翁房间
    const rooms = data.monopoly || [];
    renderOngoingGames(rooms);
  } catch (e) {
    console.error('Failed to fetch rooms:', e);
  }
}

function startLobbyAutoRefresh() {
  stopLobbyAutoRefresh();
  lobbyRefreshInterval = setInterval(refreshLobbyRooms, 5000);
}

function stopLobbyAutoRefresh() {
  if (lobbyRefreshInterval) {
    clearInterval(lobbyRefreshInterval);
    lobbyRefreshInterval = null;
  }
}

// 大厅区域切换
function switchLobbySection(section) {
  document.querySelectorAll('.section-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.section-tab[data-section="${section}"]`).classList.add('active');
  document.querySelectorAll('.lobby-section-content').forEach(c => c.classList.remove('active'));
  document.getElementById('section-' + section).classList.add('active');
  if (section === 'history') {
    loadLobbyHistory();
  }
}

// 加载友情链接
async function loadFriendLinks() {
  try {
    const res = await apiFetch('/api/links');
    const links = await res.json();
    const container = document.getElementById('friend-links-container');
    const list = document.getElementById('friend-links');
    if (links && links.length > 0) {
      list.innerHTML = links.map(link => `
        <a href="${escapeHtml(link.url)}" target="_blank" rel="noopener" class="friend-link">
          ${escapeHtml(link.name)}
          ${link.description ? `<span class="link-desc">${escapeHtml(link.description)}</span>` : ''}
        </a>
      `).join('');
      container.style.display = 'block';
    } else {
      container.style.display = 'none';
    }
  } catch (e) {
    console.error('Failed to load friend links:', e);
  }
}

// 加载大厅历史对局
async function loadLobbyHistory() {
  const container = document.getElementById('lobby-history-list');
  if (!container) return;
  container.innerHTML = '<p class="empty-hint">加载中...</p>';
  try {
    const res = await apiFetch('/api/history?limit=30');
    const history = await res.json();
    if (!history || history.length === 0) {
      container.innerHTML = '<p class="empty-hint">暂无历史对局记录</p>';
      return;
    }
    container.innerHTML = '';
    for (const game of history) {
      const item = document.createElement('div');
      item.className = 'lobby-history-item';
      const date = new Date((game.ended_at || game.created_at) * 1000);
      const dateStr = date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const duration = game.duration > 0 ? Math.floor(game.duration / 60) + '分钟' : '未知';
      const playersStr = (game.players || []).map(p => p.nickname).join(' vs ');
      item.innerHTML = `
        <div class="lh-header">
          <span class="lh-winner">🏆 ${escapeHtml(game.winner_name || '未知')}</span>
          <span class="lh-date">${dateStr} · ${duration}</span>
        </div>
        <div class="lh-players">${escapeHtml(playersStr)}</div>
        <button class="btn btn-small btn-secondary" style="margin-top:6px;" onclick="viewHistoryDetail(${game.id})">查看详情</button>
      `;
      container.appendChild(item);
    }
  } catch (e) {
    container.innerHTML = '<p class="empty-hint">加载失败</p>';
  }
}

function renderOngoingGames(rooms) {
  const container = document.getElementById('ongoing-games');
  if (!rooms || rooms.length === 0) {
    container.innerHTML = '<p class="empty-hint">暂无进行中的对局</p>';
    return;
  }
  container.innerHTML = '';
  for (const room of rooms) {
    const card = document.createElement('div');
    card.className = 'ongoing-game-card';
    const stateLabel = room.gameState === 'waiting' ? '等待中' : room.gameState === 'playing' ? '游戏中' : room.gameState === 'preAuction' ? '拍卖中' : '已结束';
    const stateClass = room.gameState === 'waiting' ? 'state-waiting' : 'state-playing';

    const playerAvatars = room.players.slice(0, 4).map(p =>
      p.avatar
        ? `<img src="${p.avatar}" class="mini-avatar" alt="" onerror="this.style.display='none'">`
        : `<div class="mini-avatar" style="background:${p.color}"></div>`
    ).join('');

    card.innerHTML = `
      <div class="og-header">
        <span class="og-code">${room.roomCode}</span>
        <span class="og-state ${stateClass}">${stateLabel}</span>
      </div>
      <div class="og-players">${playerAvatars} <span class="og-count">${room.playerCount}/${room.maxPlayers}</span></div>
      <div class="og-actions">
        <button class="btn btn-small btn-primary" onclick="spectateRoom('${room.roomCode}')">👁 围观</button>
        <button class="btn btn-small btn-secondary" onclick="copyRoomLink('${room.roomCode}')">🔗 链接</button>
      </div>
    `;
    container.appendChild(card);
  }
}

function spectateRoom(roomCode) {
  socket.emit('spectateRoom', { roomCode });
}

function copyRoomLink(roomCode) {
  const link = `${window.location.origin}/dfw/${roomCode}`;
  navigator.clipboard.writeText(link).then(() => showToast('链接已复制', 'success'));
}

// ========== 创建房间（含配置） ==========
function handleCreateRoom() {
  const maxPlayers = parseInt(document.getElementById('max-players-select').value);
  const bankruptcyMode = parseInt(document.getElementById('bankruptcy-mode-select').value);
  const startingMoney = parseInt(document.getElementById('starting-money-select').value);
  const preGameAuction = document.getElementById('cfg-pre-auction').checked;
  const enableChance = document.getElementById('cfg-chance').checked;
  const enableCommunity = document.getElementById('cfg-community').checked;
  const enableTrade = document.getElementById('cfg-trade').checked;

  socket.emit('createRoom', {
    maxPlayers, bankruptcyMode, startingMoney,
    preGameAuction, enableChance, enableCommunity, enableTrade,
  });
}

// ========== 视图管理 ==========
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
}

// ========== 音效按钮 ==========
function updateSoundButton() {
  const btn = document.getElementById('btn-sound');
  if (btn) {
    btn.textContent = isSoundEnabled() ? '🔊' : '🔇';
  }
}

// ========== 主渲染 ==========
function renderAll() {
  if (!state) return;
  const me = state.players.find(p => p.id === mySocketId);
  const inGame = !!me;

  if (state.gameState === 'waiting') {
    showView('lobby');
    renderLobby();
  } else {
    showView('game');
    renderBoard();
    renderPlayers();
    renderDice();
    renderActions(me);
    renderLog();
    renderChat();
    renderAuction();
    renderCardModal();
    renderTrade();
    renderGameOver();
    // 认输按钮：仅游戏中且非破产玩家可见
    const surrenderBtn = document.getElementById('btn-surrender');
    if (surrenderBtn) {
      surrenderBtn.style.display = (me && !me.bankrupt && (state.gameState === 'playing' || state.gameState === 'preAuction')) ? '' : 'none';
    }
  }
}

// ========== 大厅渲染 ==========
function renderLobby() {
  const me = state.players.find(p => p.id === mySocketId);
  if (!me) {
    document.getElementById('room-waiting').style.display = 'none';
    document.querySelector('.lobby-page').style.display = 'flex';
    return;
  }
  document.querySelector('.lobby-page').style.display = 'none';
  document.getElementById('room-waiting').style.display = 'block';
  document.getElementById('player-count').textContent = state.players.length;
  document.getElementById('max-player-count').textContent = state.maxPlayers;
  document.getElementById('display-bankruptcy-mode').textContent =
    state.bankruptcyMode === 1 ? '模式1（随时可主动破产）' : '模式2（经典规则）';
  document.getElementById('display-starting-money').textContent = state.startingMoney;

  // 显示配置信息
  const preAuctionEl = document.getElementById('display-pre-auction');
  if (state.preGameAuction) {
    preAuctionEl.textContent = '开局将随机抽取地皮进行拍卖';
    preAuctionEl.style.display = '';
  } else {
    preAuctionEl.style.display = 'none';
  }

  const propsEl = document.getElementById('display-props');
  const props = [];
  if (state.enableChance) props.push('机会卡');
  if (state.enableCommunity) props.push('社区福利卡');
  if (state.enableTrade) props.push('玩家交易');
  propsEl.textContent = props.length > 0 ? '启用：' + props.join('、') : '无额外道具';

  // 玩家列表
  const list = document.getElementById('lobby-players');
  list.innerHTML = '';
  for (const p of state.players) {
    const card = document.createElement('div');
    card.className = 'lobby-player-card';
    card.innerHTML = `
      ${p.avatar ? `<img src="${p.avatar}" alt="" onerror="this.style.display='none'">` : `<div style="width:32px;height:32px;border-radius:50%;background:${p.color}"></div>`}
      <div>
        <div>${escapeHtml(p.nickname)}</div>
        ${p.isHost ? '<div class="host-badge">👑 房主</div>' : ''}
      </div>
    `;
    list.appendChild(card);
  }

  // 开始按钮
  const startBtn = document.getElementById('btn-start-game');
  if (me.isHost && state.players.length >= 2) {
    startBtn.style.display = 'block';
  } else {
    startBtn.style.display = 'none';
  }
}

// ========== 棋盘渲染 ==========
function getGridPosition(spaceId) {
  if (spaceId >= 1 && spaceId <= 11) return { row: 10, col: 11 - spaceId };
  if (spaceId >= 11 && spaceId <= 21) return { row: 21 - spaceId, col: 0 };
  if (spaceId >= 21 && spaceId <= 31) return { row: 0, col: spaceId - 21 };
  if (spaceId >= 31 && spaceId <= 40) return { row: spaceId - 31, col: 10 };
  return { row: 0, col: 0 };
}

function renderBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';

  for (const space of state.board) {
    const prop = state.properties[space.id];
    const pos = getGridPosition(space.id);
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.style.gridRow = pos.row + 1;
    cell.style.gridColumn = pos.col + 1;
    cell.dataset.spaceId = space.id;

    const isCorner = space.type.startsWith('corner');
    if (isCorner) cell.classList.add('cell-corner');

    let html = '';
    if (isCorner) {
      const bg = { corner_go: '#2e7d32', corner_jail: '#e65100', corner_park: '#1565c0', corner_rest: '#b71c1c' };
      cell.style.background = bg[space.type] || '';
      html = `<div class="corner-icon">${CELL_ICONS[space.type] || ''}</div>`;
      html += `<div class="corner-name">${space.name}</div>`;
    } else if (space.type === 'property') {
      html = `<div class="color-bar" style="background:${COLOR_HEX[space.color] || '#888'}"></div>`;
      html += `<div class="cell-name">${space.name}</div>`;
      html += `<div class="cell-price">$${space.price}</div>`;
      if (prop && prop.houses > 0) {
        html += '<div class="houses">';
        if (prop.houses === 5) html += '<span class="hotel-icon">🏨</span>';
        else { for (let i = 0; i < prop.houses; i++) html += '<span class="house-icon">🏠</span>'; }
        html += '</div>';
      }
    } else if (space.type === 'station') {
      html = `<div class="color-bar" style="background:${COLOR_HEX.station}"></div>`;
      html += `<div class="cell-name">${CELL_ICONS.station} ${space.name}</div>`;
      html += `<div class="cell-price">$${space.price}</div>`;
    } else if (space.type === 'treasure') {
      html = `<div class="color-bar" style="background:#FFD700"></div>`;
      html += `<div class="cell-name">${CELL_ICONS.treasure} ${space.name}</div>`;
      html += `<div class="cell-price">$${space.price}</div>`;
    } else {
      html = `<div style="font-size:16px;margin-top:4px">${CELL_ICONS[space.type] || ''}</div>`;
      html += `<div class="cell-name">${space.name}</div>`;
    }
    cell.innerHTML = html;

    // 所有者：地块背景变为玩家主题色
    if (prop && prop.ownerId) {
      const owner = state.players.find(p => p.id === prop.ownerId);
      if (owner) {
        if (!isCorner) cell.style.background = owner.color + '33';
        const border = document.createElement('div');
        border.className = 'cell-owner-border';
        border.style.borderColor = owner.color;
        cell.appendChild(border);
      }
      if (prop.mortgaged) cell.classList.add('cell-mortgaged');
    }

    // 玩家棋子
    const tokensHere = state.players.filter(p => p.position === space.id && !p.bankrupt);
    if (tokensHere.length > 0) {
      const tokensDiv = document.createElement('div');
      tokensDiv.className = 'tokens';
      for (const p of tokensHere) {
        const token = document.createElement('div');
        token.className = 'token';
        if (p.id === state.currentPlayerId) token.classList.add('current');
        token.style.background = p.color;
        tokensDiv.appendChild(token);
      }
      cell.appendChild(tokensDiv);
    }

    cell.addEventListener('click', () => showPropertyDetail(space.id));
    board.appendChild(cell);
  }
}

// ========== 玩家面板 ==========
function renderPlayers() {
  const panel = document.getElementById('players-panel');
  panel.innerHTML = '';
  for (const p of state.players) {
    const card = document.createElement('div');
    card.className = 'player-card';
    if (p.id === state.currentPlayerId && !p.bankrupt) card.classList.add('current');
    if (p.bankrupt) card.classList.add('bankrupt');

    let statusHtml = '';
    if (p.bankrupt) statusHtml = '<span class="p-jail">已破产</span>';
    else if (p.disconnected) statusHtml = '已断线';
    else if (p.inJail) statusHtml = `<span class="p-jail">🔒监狱(${p.jailTurns}/3)</span>`;
    else statusHtml = `📍${state.board[p.position - 1].name}`;

    const me = state.players.find(pl => pl.id === mySocketId);
    const canTrade = me && p.id !== mySocketId && !p.bankrupt && !me.bankrupt && state.gameState === 'playing' && !state.pendingTrade && state.enableTrade;
    const tradeBtnHtml = canTrade ? `<button class="p-trade-btn" onclick="openTrade('${p.id}')">🤝 交易</button>` : '';

    card.innerHTML = `
      <div class="p-color-bar" style="background:${p.color}"></div>
      ${p.avatar
        ? `<img class="p-avatar" src="${p.avatar}" alt="" onerror="this.style.display='none'">`
        : `<div class="p-avatar" style="background:${p.color}"></div>`}
      <div class="p-name">${escapeHtml(p.nickname)}${p.isHost ? ' 👑' : ''}</div>
      <div class="p-money">$${formatNum(p.money)}</div>
      <div class="p-status">${statusHtml}</div>
      ${p.getOutCards > 0 ? `<div class="p-cards">🎫×${p.getOutCards}</div>` : ''}
      ${tradeBtnHtml}
    `;
    panel.appendChild(card);
  }
}

// ========== 骰子 ==========
function renderDice() {
  const d1 = document.getElementById('dice-1');
  const d2 = document.getElementById('dice-2');
  if (state.lastRoll) {
    d1.textContent = DICE_FACES[state.lastRoll.d1 - 1];
    d2.textContent = DICE_FACES[state.lastRoll.d2 - 1];
    if (state.lastRoll !== prevRoll) {
      d1.classList.add('rolling');
      d2.classList.add('rolling');
      Sounds.dice();
      setTimeout(() => { d1.classList.remove('rolling'); d2.classList.remove('rolling'); }, 500);
      prevRoll = state.lastRoll;
    }
  } else {
    d1.textContent = DICE_FACES[0];
    d2.textContent = DICE_FACES[1];
  }

  // 回合信息
  const turnInfo = document.getElementById('turn-info');
  if (state.gameState === 'preAuction') {
    turnInfo.textContent = `开局拍卖 ${state.preGameIndex + 1}/${state.preGameQueue.length}`;
  } else if (state.gameState === 'playing') {
    const current = state.players[state.currentPlayerIndex];
    if (current) {
      let info = `${current.nickname} 的回合`;
      if (state.turnPhase === 'jail') info += ' (监狱)';
      if (state.turnPhase === 'debt') info += ' (负债!)';
      turnInfo.textContent = info;
    }
  } else if (state.gameState === 'ended') {
    turnInfo.textContent = '游戏结束';
  }
  const meForBoard = state.players.find(p => p.id === mySocketId);
  renderBoardActions(meForBoard);
}

// ========== 棋盘中心操作按钮 ==========
function renderBoardActions(me) {
  const container = document.getElementById('board-actions');
  const isMyTurn = me && state.currentPlayerId === mySocketId && !me.bankrupt && state.gameState === 'playing';
  let html = '';

  if (state.gameState === 'preAuction') {
    html = '<div style="font-size:12px;color:var(--text-secondary);text-align:center">拍卖进行中，请在弹窗出价</div>';
  } else if (state.gameState === 'ended') {
    html = '';
  } else if (!me || me.bankrupt) {
    html = '';
  } else if (state.auction) {
    html = '<div style="font-size:12px;color:var(--text-secondary);text-align:center">拍卖进行中，请在弹窗出价</div>';
  } else if (isMyTurn) {
    switch (state.turnPhase) {
      case 'roll':
        html = '<button class="btn btn-primary btn-large" onclick="socket.emit(\'rollDice\')">🎲 掷骰子</button>';
        break;
      case 'jail':
        html = '<button class="btn btn-primary" onclick="socket.emit(\'rollDice\')">🎲 掷骰出狱</button>';
        html += '<button class="btn btn-secondary btn-small" onclick="socket.emit(\'payJailFine\')">💰 缴$50</button>';
        if (me.getOutCards > 0)
          html += `<button class="btn btn-success btn-small" onclick="socket.emit(\'useJailCard\')">🎫 出狱卡(${me.getOutCards})</button>`;
        break;
      case 'pendingBuy':
        const space = state.board[me.position - 1];
        html += `<button class="btn btn-success" onclick="socket.emit(\'buyProperty\')">🏠 购买 $${space.price}</button>`;
        html += '<button class="btn btn-secondary btn-small" onclick="socket.emit(\'declineBuy\')">🔨 拍卖</button>';
        break;
      case 'action':
        html = '<button class="btn btn-primary" onclick="socket.emit(\'endTurn\')">✅ 结束回合</button>';
        break;
      case 'debt':
        const debt = state.pendingAction ? state.pendingAction.amount : 0;
        html += `<div class="debt-warning" style="text-align:center">⚠️ 欠款 $${debt}，余额 $${me.money}，点击地块抵押/卖房</div>`;
        if (state.canDeclareBankruptcy)
          html += '<button class="btn btn-danger btn-small" onclick="socket.emit(\'declareBankruptcy\')">💀 申请破产</button>';
        break;
    }
  } else {
    const current = state.players[state.currentPlayerIndex];
    if (current) {
      html = `<div style="font-size:12px;color:var(--text-secondary);text-align:center">等待 ${escapeHtml(current.nickname)} 行动...</div>`;
    }
  }
  container.innerHTML = html;
}

// ========== 操作面板（侧边栏，辅助） ==========
function renderActions(me) {
  const panel = document.getElementById('action-panel');
  const isMyTurn = me && state.currentPlayerId === mySocketId && !me.bankrupt && state.gameState === 'playing';
  let html = '';

  if (state.gameState === 'preAuction') {
    html = '<div class="action-title">⏳ 开局拍卖进行中</div>';
  } else if (state.gameState === 'ended') {
    html = '<div class="action-title">游戏已结束</div>';
  } else if (!me || me.bankrupt) {
    html = '<div class="action-title">观战中</div>';
  } else if (state.auction) {
    html = '<div class="action-title">⏳ 拍卖进行中</div>';
  } else if (isMyTurn) {
    html = '<div class="action-title">' + (state.turnPhase === 'action' ? '点击棋盘地块可建房/抵押/交易' : '请操作棋盘中央按钮') + '</div>';
    if (state.turnPhase === 'debt') {
      const debt = state.pendingAction ? state.pendingAction.amount : 0;
      html += `<div class="debt-warning">⚠️ 需筹集 $${debt}！</div>`;
    }
    if (state.pendingTrade && state.pendingTrade.targetId === mySocketId) {
      html += `<div class="debt-warning" style="border-color:var(--accent-yellow);color:var(--accent-yellow);background:rgba(210,153,34,0.12)">📨 收到交易报价，点击处理</div>`;
    }
  } else {
    const current = state.players[state.currentPlayerIndex];
    if (current) {
      html = `<div class="action-title">等待 ${escapeHtml(current.nickname)} 行动...</div>`;
    }
    if (state.pendingTrade && state.pendingTrade.targetId === mySocketId) {
      html += `<div class="debt-warning" style="border-color:var(--accent-yellow);color:var(--accent-yellow);background:rgba(210,153,34,0.12)">📨 收到交易报价，点击处理</div>`;
    }
  }
  panel.innerHTML = html;
}

// ========== 日志 ==========
function renderLog() {
  const log = document.getElementById('game-log');
  const wasAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 50;
  log.innerHTML = '';
  const logs = state.logs;
  for (let i = logs.length - 1; i >= 0 && i >= logs.length - 50; i--) {
    const entry = logs[i];
    const div = document.createElement('div');
    div.className = 'log-entry';
    if (i === logs.length - 1) div.classList.add('highlight');
    const time = new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    div.innerHTML = `<span class="log-time">${time}</span>${escapeHtml(entry.message)}`;
    log.appendChild(div);
  }
  if (wasAtBottom) log.scrollTop = log.scrollHeight;
}

// ========== 聊天 ==========
function renderChat() {
  const container = document.getElementById('chat-messages');
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
  container.innerHTML = '';
  for (const msg of state.chatMessages) {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    if (msg.playerId === mySocketId) div.classList.add('me');
    div.innerHTML = `
      ${msg.avatar
        ? `<img src="${msg.avatar}" alt="" onerror="this.style.display='none'">`
        : `<div style="width:28px;height:28px;border-radius:50%;background:#666;flex-shrink:0"></div>`}
      <div>
        <div class="chat-name">${escapeHtml(msg.nickname)}</div>
        <div class="chat-bubble">${escapeHtml(msg.message)}</div>
      </div>
    `;
    container.appendChild(div);
  }
  if (wasAtBottom) container.scrollTop = container.scrollHeight;
}

function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  socket.emit('chat', { message: msg });
  input.value = '';
}

// ========== 拍卖弹窗 ==========
function renderAuction() {
  const modal = document.getElementById('auction-modal');
  if (!state.auction) {
    modal.style.display = 'none';
    if (auctionTimerInterval) { clearInterval(auctionTimerInterval); auctionTimerInterval = null; }
    return;
  }

  // 首次显示时播放音效
  if (modal.style.display !== 'flex') {
    Sounds.auction();
  }

  modal.style.display = 'flex';
  auctionEndAt = Date.now() + state.auction.remainingTime;

  const space = state.board[state.auction.spaceId - 1];
  const propInfo = document.getElementById('auction-property');
  let colorBar = '';
  if (space.color && COLOR_HEX[space.color]) {
    colorBar = `<div style="height:6px;background:${COLOR_HEX[space.color]};border-radius:3px;margin-bottom:8px"></div>`;
  }
  propInfo.innerHTML = `${colorBar}<div class="ap-name">${space.name}</div><div class="ap-price">原价 $${space.price}</div>`;

  const highest = document.getElementById('auction-highest');
  if (state.auction.currentHighest.playerId) {
    const bidder = state.players.find(p => p.id === state.auction.currentHighest.playerId);
    highest.innerHTML = `最高出价: <span class="amount">$${state.auction.currentHighest.amount}</span> by ${escapeHtml(bidder ? bidder.nickname : '?')}`;
  } else {
    highest.innerHTML = '暂无出价（底价 $0）';
  }

  const bidders = document.getElementById('auction-bidders');
  const bids = Object.entries(state.auction.bids);
  if (bids.length > 0) {
    bidders.innerHTML = '出价记录: ' + bids.map(([pid, amt]) => {
      const p = state.players.find(pl => pl.id === pid);
      return `${escapeHtml(p ? p.nickname : '?')}:$${amt}`;
    }).join(', ');
  } else {
    bidders.innerHTML = '';
  }

  const me = state.players.find(p => p.id === mySocketId);
  const slider = document.getElementById('bid-slider');
  const maxBid = me ? me.money : 1000;
  const minBid = state.auction.currentHighest.amount + 1;
  slider.min = minBid;
  slider.max = Math.max(minBid, maxBid);
  const inputEl = document.getElementById('bid-input');
  const cur = parseInt(inputEl.value) || 0;
  if (cur < minBid) { inputEl.value = minBid; }
  syncSlider();
  updateBidDisplay();

  if (!auctionTimerInterval) {
    auctionTimerInterval = setInterval(updateAuctionTimer, 200);
  }
}

function updateAuctionTimer() {
  if (!auctionEndAt) return;
  const remaining = Math.max(0, auctionEndAt - Date.now());
  const pct = (remaining / 10000) * 100;
  const bar = document.getElementById('timer-bar');
  bar.style.width = pct + '%';
  bar.classList.toggle('warning', pct < 50 && pct >= 25);
  bar.classList.toggle('danger', pct < 25);
}

function syncSlider() {
  const input = document.getElementById('bid-input');
  const slider = document.getElementById('bid-slider');
  const val = parseInt(input.value) || 0;
  const min = parseInt(slider.min) || 0;
  const max = parseInt(slider.max) || 100;
  slider.value = Math.max(min, Math.min(max, val));
}

function updateBidDisplay() {
  const input = document.getElementById('bid-input');
  const val = parseInt(input.value) || 0;
  document.getElementById('bid-amount-display').textContent = '$' + formatNum(val);
}

function handleQuickBid(btn) {
  const input = document.getElementById('bid-input');
  if (btn.dataset.set === 'minbid') {
    const min = state.auction ? state.auction.currentHighest.amount + 1 : 1;
    input.value = min;
  } else if (btn.dataset.set === 'allin') {
    const me = state.players.find(p => p.id === mySocketId);
    input.value = me ? me.money : 0;
  } else {
    const current = parseInt(input.value) || 0;
    input.value = Math.max(0, current + parseInt(btn.dataset.add));
  }
  syncSlider();
  updateBidDisplay();
}

function placeBid() {
  const input = document.getElementById('bid-input');
  const amount = parseInt(input.value);
  if (isNaN(amount) || amount < 1) { showToast('请输入有效金额', 'error'); return; }
  socket.emit('bid', { amount });
  Sounds.bid();
}

// ========== 交易功能 ==========
let tradeTargetId = null;
let tradeMySelected = new Set();
let tradeTheirSelected = new Set();

function openTrade(targetId) {
  if (state.pendingTrade) {
    showToast('已有交易进行中', 'error');
    return;
  }
  tradeTargetId = targetId;
  tradeMySelected = new Set();
  tradeTheirSelected = new Set();
  renderTradeModal();
  document.getElementById('trade-modal').style.display = 'flex';
}

function renderTradeModal() {
  const me = state.players.find(p => p.id === mySocketId);
  const target = state.players.find(p => p.id === tradeTargetId);
  if (!me || !target) { document.getElementById('trade-modal').style.display = 'none'; return; }

  document.getElementById('trade-my-name').textContent = `${me.nickname} ($${formatNum(me.money)})`;
  document.getElementById('trade-their-name').textContent = `${target.nickname} ($${formatNum(target.money)})`;
  document.getElementById('trade-my-money').value = 0;
  document.getElementById('trade-their-money').value = 0;
  renderTradePropertyList('my', me, tradeMySelected);
  renderTradePropertyList('their', target, tradeTheirSelected);
  document.getElementById('trade-status').textContent = '';
  document.getElementById('btn-trade-send').style.display = '';
  document.getElementById('btn-trade-accept').style.display = 'none';
  document.getElementById('btn-trade-decline').style.display = 'none';
}

function renderTradePropertyList(side, player, selected) {
  const container = document.getElementById(side === 'my' ? 'trade-my-properties' : 'trade-their-properties');
  container.innerHTML = '';
  const props = player.properties;
  if (props.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px;">无地产</div>';
    return;
  }
  for (const sid of props) {
    const space = state.board[sid - 1];
    const prop = state.properties[sid];
    const item = document.createElement('div');
    item.className = 'trade-prop-item';
    if (selected.has(sid)) item.classList.add('selected');
    const colorHex = space.color ? (COLOR_HEX[space.color] || '#888') : '#888';
    item.innerHTML = `
      <div class="tp-color" style="background:${colorHex}"></div>
      <span style="flex:1">${space.name}</span>
      ${prop.houses > 0 ? '<span style="font-size:10px;color:var(--accent-yellow)">🏠'+prop.houses+'</span>' : ''}
      ${prop.mortgaged ? '<span class="tp-mortgaged">抵押</span>' : ''}
      <span style="font-size:11px;color:var(--text-secondary)">$${space.price}</span>
    `;
    if (prop.houses > 0) {
      item.style.opacity = '0.5';
      item.title = '有建筑，无法交易';
    } else {
      item.addEventListener('click', () => {
        if (selected.has(sid)) selected.delete(sid);
        else selected.add(sid);
        renderTradePropertyList(side, player, selected);
      });
    }
    container.appendChild(item);
  }
}

function sendTradeOffer() {
  const myMoney = parseInt(document.getElementById('trade-my-money').value) || 0;
  const theirMoney = parseInt(document.getElementById('trade-their-money').value) || 0;
  socket.emit('proposeTrade', {
    targetId: tradeTargetId,
    myMoney,
    theirMoney,
    myProperties: [...tradeMySelected],
    theirProperties: [...tradeTheirSelected],
  });
  document.getElementById('trade-status').textContent = '报价已发送，等待对方回应...';
  document.getElementById('btn-trade-send').style.display = 'none';
}

function renderTrade() {
  if (!state.pendingTrade) {
    if (document.getElementById('trade-modal').style.display === 'flex') {
      document.getElementById('trade-modal').style.display = 'none';
      tradeTargetId = null;
    }
    return;
  }
  const t = state.pendingTrade;
  if (t.targetId === mySocketId) {
    tradeTargetId = t.fromId;
    const me = state.players.find(p => p.id === mySocketId);
    const from = state.players.find(p => p.id === t.fromId);
    document.getElementById('trade-my-name').textContent = `${me.nickname} ($${formatNum(me.money)})`;
    document.getElementById('trade-their-name').textContent = `${from.nickname} ($${formatNum(from.money)})`;
    document.getElementById('trade-my-money').value = t.theirMoney;
    document.getElementById('trade-their-money').value = t.myMoney;
    tradeMySelected = new Set(t.theirProperties);
    tradeTheirSelected = new Set(t.myProperties);
    renderTradePropertyList('my', me, tradeMySelected);
    renderTradePropertyList('their', from, tradeTheirSelected);
    document.getElementById('trade-status').textContent = `${from.nickname} 向你发起交易，是否接受？`;
    document.getElementById('btn-trade-send').style.display = 'none';
    document.getElementById('btn-trade-accept').style.display = '';
    document.getElementById('btn-trade-decline').style.display = '';
    document.getElementById('trade-modal').style.display = 'flex';
    Sounds.notify();
  } else if (t.fromId === mySocketId) {
    document.getElementById('trade-status').textContent = '报价已发送，等待对方回应...';
    document.getElementById('btn-trade-send').style.display = 'none';
    document.getElementById('btn-trade-accept').style.display = 'none';
    document.getElementById('btn-trade-decline').style.display = 'none';
    document.getElementById('btn-trade-cancel').style.display = '';
    document.getElementById('trade-modal').style.display = 'flex';
  }
}

// ========== 卡片弹窗 ==========
function renderCardModal() {
  if (!state.lastCardDrawn) return;
  const card = state.lastCardDrawn.card;
  const cardId = state.lastCardDrawn.card.id + '_' + state.logs.length;

  if (cardId === prevCardId) return;
  prevCardId = cardId;

  Sounds.card();
  const modal = document.getElementById('card-modal');
  document.getElementById('card-icon').textContent = state.lastCardDrawn.type === 'chance' ? '❓' : '🎁';
  document.getElementById('card-title').textContent = state.lastCardDrawn.type === 'chance' ? '机会' : '社区福利';
  document.getElementById('card-text').textContent = card.text;
  modal.style.display = 'flex';
}

// ========== 地块详情 ==========
function showPropertyDetail(spaceId) {
  const space = state.board[spaceId - 1];
  const prop = state.properties[spaceId];
  const me = state.players.find(p => p.id === mySocketId);
  const detail = document.getElementById('property-detail');
  const actions = document.getElementById('property-actions');

  let html = '';
  if (space.color && COLOR_HEX[space.color]) {
    html += `<div class="prop-detail-bar" style="background:${COLOR_HEX[space.color]}"></div>`;
  }
  html += '<div class="prop-detail-body">';
  html += `<h3>${space.name}</h3>`;

  const typeDesc = {
    property: '地产地块：拥有同色系全部地块可建房升级，租金随建筑增加',
    station: '交通地块：持有车站越多，过路租金越高',
    treasure: '💎 宝藏地块：可购买的固定收益投资，他人踩中需支付固定租金',
    chance: '机会格：随机抽取机会卡片，可能获得金钱、移动或道具',
    community: '社区福利格：随机抽取福利卡片',
    tax: '税务格：踩中需缴纳税款',
  };
  if (typeDesc[space.type]) {
    html += `<p style="font-size:12px;color:var(--text-secondary);margin-bottom:10px;line-height:1.5">${typeDesc[space.type]}</p>`;
  }

  if (['property', 'station', 'treasure'].includes(space.type)) {
    html += `<table>
      <tr><td>购入价</td><td>$${space.price}</td></tr>`;

    if (space.type === 'property') {
      html += `<tr><td>租金 (0房)</td><td>$${space.baseRent}</td></tr>`;
      const labels = ['1栋房', '2栋房', '3栋房', '4栋房', '酒店'];
      for (let i = 0; i < 5; i++) {
        html += `<tr><td>${labels[i]}</td><td>$${space.houseRents[i]}</td></tr>`;
      }
      html += `<tr><td>建房费用</td><td>$${space.buildCost}</td></tr>`;
    } else if (space.type === 'station') {
      html += `<tr><td>1站租金</td><td>$25</td></tr>`;
      html += `<tr><td>2站租金</td><td>$50</td></tr>`;
      html += `<tr><td>3站租金</td><td>$75</td></tr>`;
      html += `<tr><td>4站租金</td><td>$100</td></tr>`;
    } else if (space.type === 'treasure') {
      html += `<tr><td>固定过路收益</td><td>$${space.baseRent}</td></tr>`;
      html += `<tr><td>回本期</td><td>1次踩中</td></tr>`;
    }

    html += `<tr><td>抵押价值</td><td>$${Math.floor(space.price / 2)}</td></tr>`;
    html += `<tr><td>赎回费用</td><td>$${Math.ceil(space.price / 2 * 1.1)}</td></tr>`;
    html += '</table>';

    if (prop && prop.ownerId) {
      const owner = state.players.find(p => p.id === prop.ownerId);
      html += `<div class="owner-info">`;
      html += `<div>所有者: <span style="color:${owner ? owner.color : ''}">${escapeHtml(owner ? owner.nickname : '?')}</span></div>`;
      if (space.type === 'property' && prop.houses > 0) {
        html += `<div>建筑: ${prop.houses === 5 ? '🏨 酒店' : '🏠'.repeat(prop.houses)}</div>`;
      }
      html += `<div>状态: ${prop.mortgaged ? '已抵押' : '正常'}</div>`;
      html += `</div>`;
    } else {
      html += `<div class="owner-info"><div>状态: 无主</div></div>`;
    }
  } else {
    html += `<p style="color:var(--text-secondary)">${space.special}</p>`;
  }

  html += '</div>';
  detail.innerHTML = html;

  let actHtml = '';
  if (me && prop && prop.ownerId === mySocketId && state.gameState === 'playing' && !me.bankrupt) {
    actHtml = '<div class="prop-actions">';
    if (space.type === 'property') {
      if (prop.houses < 5 && !prop.mortgaged) {
        actHtml += `<button class="btn btn-success btn-small" onclick="doBuildHouse(${spaceId})">建房 $${space.buildCost}</button>`;
      }
      if (prop.houses > 0) {
        actHtml += `<button class="btn btn-secondary btn-small" onclick="doSellHouse(${spaceId})">卖房 +$${Math.floor(space.buildCost / 2)}</button>`;
      }
    }
    if (!prop.mortgaged && prop.houses === 0)
      actHtml += `<button class="btn btn-secondary btn-small" onclick="doMortgage(${spaceId})">抵押 +$${Math.floor(space.price / 2)}</button>`;
    if (prop.mortgaged)
      actHtml += `<button class="btn btn-primary btn-small" onclick="doRedeem(${spaceId})">赎回 -$${Math.ceil(space.price / 2 * 1.1)}</button>`;
    actHtml += '</div>';
  }
  actions.innerHTML = actHtml;

  document.getElementById('property-modal').style.display = 'flex';
}

function doBuildHouse(spaceId) {
  socket.emit('buildHouse', { spaceId });
  Sounds.build();
  refreshProperty(spaceId);
}
function doSellHouse(spaceId) {
  socket.emit('sellHouse', { spaceId });
  refreshProperty(spaceId);
}
function doMortgage(spaceId) {
  socket.emit('mortgage', { spaceId });
  refreshProperty(spaceId);
}
function doRedeem(spaceId) {
  socket.emit('redeem', { spaceId });
  Sounds.buy();
  refreshProperty(spaceId);
}

function refreshProperty(spaceId) {
  setTimeout(() => {
    if (document.getElementById('property-modal').style.display === 'flex') {
      showPropertyDetail(spaceId);
    }
  }, 300);
}

// ========== 历史对局 ==========
async function showHistoryModal() {
  const modal = document.getElementById('history-modal');
  const listEl = document.getElementById('history-list');
  const detailEl = document.getElementById('history-detail');
  listEl.style.display = '';
  detailEl.style.display = 'none';

  listEl.innerHTML = '<p class="empty-hint">加载中...</p>';
  modal.style.display = 'flex';

  try {
    const res = await apiFetch('/api/history?limit=30');
    const history = await res.json();
    if (history.length === 0) {
      listEl.innerHTML = '<p class="empty-hint">暂无历史对局记录</p>';
      return;
    }
    listEl.innerHTML = '';
    for (const game of history) {
      const item = document.createElement('div');
      item.className = 'history-item';
      const date = new Date((game.ended_at || game.created_at) * 1000);
      const dateStr = date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const duration = game.duration > 0 ? Math.floor(game.duration / 60) + '分钟' : '未知';
      const playersStr = game.players.map(p => p.nickname).join(' vs ');

      item.innerHTML = `
        <div class="hi-header">
          <span class="hi-winner">🏆 ${escapeHtml(game.winner_name || '未知')}</span>
          <span class="hi-date">${dateStr} · ${duration}</span>
        </div>
        <div class="hi-players">${escapeHtml(playersStr)}</div>
        <button class="btn btn-small btn-secondary" onclick="viewHistoryDetail(${game.id})">查看详情</button>
      `;
      listEl.appendChild(item);
    }
  } catch (e) {
    listEl.innerHTML = '<p class="empty-hint">加载失败</p>';
  }
}

async function viewHistoryDetail(id) {
  const detailEl = document.getElementById('history-detail');
  const contentEl = document.getElementById('history-detail-content');
  document.getElementById('history-list').style.display = 'none';
  detailEl.style.display = '';
  contentEl.innerHTML = '<p class="empty-hint">加载中...</p>';

  try {
    const res = await apiFetch(`/api/history/${id}`);
    const game = await res.json();
    let html = '';

    // 基本信息
    const date = new Date((game.ended_at || game.created_at) * 1000);
    const dateStr = date.toLocaleString('zh-CN');
    const duration = game.duration > 0 ? Math.floor(game.duration / 60) + '分钟' : '未知';
    html += `<div class="hd-info">房间 ${game.room_code} · ${dateStr} · 用时${duration}</div>`;

    // 排名
    if (game.rankings && game.rankings.length > 0) {
      html += '<div class="hd-rankings">';
      for (const r of game.rankings) {
        const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣'][r.rank - 1] || `${r.rank}.`;
        html += `<div class="hd-rank-item ${r.isWinner ? 'winner' : ''}">
          <span class="hd-medal">${medal}</span>
          ${r.avatar ? `<img src="${r.avatar}" class="hd-avatar" alt="" onerror="this.style.display='none'">` : `<div class="hd-avatar" style="background:${r.color}"></div>`}
          <span class="hd-name">${escapeHtml(r.nickname)}${r.bankrupt ? ' (破产)' : ''}</span>
          <span class="hd-money">$${formatNum(r.netWorth)}</span>
        </div>`;
      }
      html += '</div>';
    }

    // 日志
    if (game.logs && game.logs.length > 0) {
      html += '<div class="hd-logs-title">📋 对局日志</div>';
      html += '<div class="hd-logs">';
      for (const log of game.logs) {
        const time = new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        html += `<div class="hd-log-entry"><span class="log-time">${time}</span>${escapeHtml(log.message)}</div>`;
      }
      html += '</div>';
    }

    contentEl.innerHTML = html;
  } catch (e) {
    contentEl.innerHTML = '<p class="empty-hint">加载失败</p>';
  }
}

// ========== 游戏结束 ==========
function renderGameOver() {
  if (!state.winner || state.winner.id === prevWinner) return;
  prevWinner = state.winner.id;

  Sounds.win();
  const modal = document.getElementById('gameover-modal');
  document.getElementById('gameover-title').textContent = '游戏结束！';
  document.getElementById('gameover-winner').innerHTML = `🏆 冠军: ${escapeHtml(state.winner.nickname)}`;

  const rankings = [...state.players].sort((a, b) => {
    if (a.bankrupt && !b.bankrupt) return 1;
    if (!a.bankrupt && b.bankrupt) return -1;
    return b.netWorth - a.netWorth;
  });

  const rankHtml = rankings.map((p, i) => {
    const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣'][i] || `${i + 1}.`;
    return `
      <div class="ranking-item">
        <span class="rank">${medal}</span>
        ${p.avatar ? `<img src="${p.avatar}" alt="" onerror="this.style.display='none'">` : `<div style="width:32px;height:32px;border-radius:50%;background:${p.color}"></div>`}
        <span class="r-name">${escapeHtml(p.nickname)}${p.bankrupt ? ' (破产)' : ''}</span>
        <span class="r-money">$${formatNum(p.netWorth)}</span>
      </div>
    `;
  }).join('');
  document.getElementById('gameover-rankings').innerHTML = rankHtml;
  modal.style.display = 'flex';
}

// ========== 标签页 ==========
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelector(`.tab-btn[data-tab="${name}"]`).classList.add('active');
  document.getElementById(name + '-panel').classList.add('active');
}

// ========== 主题 ==========
function toggleTheme() {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', theme);
  applyTheme();
}
function applyTheme() {
  document.documentElement.setAttribute('data-theme', theme);
  const themeBtn = document.getElementById('btn-theme');
  if (themeBtn) themeBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

// ========== 工具函数 ==========
function showModal(id) { document.getElementById(id).style.display = 'flex'; }
function hideModal(id) { document.getElementById(id).style.display = 'none'; }

function showToast(message, type = '') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
  if (type !== 'error') Sounds.notify();
}

function formatNum(n) {
  return (n || 0).toLocaleString('en-US');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
