// ========== 音效系统（Web Audio API 生成，无需音频文件） ==========
let audioCtx = null;
let soundEnabled = true;

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// 从 localStorage 读取音效开关
if (localStorage.getItem('soundEnabled') === 'false') soundEnabled = false;

function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem('soundEnabled', soundEnabled);
  return soundEnabled;
}

function isSoundEnabled() { return soundEnabled; }

// 基础音调生成
function playTone(freq, duration, type = 'sine', volume = 0.15) {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (e) {}
}

// 音阶序列
function playSequence(notes, interval = 0.1) {
  if (!soundEnabled) return;
  notes.forEach((note, i) => {
    setTimeout(() => playTone(note.freq, note.dur || 0.15, note.type || 'sine', note.vol || 0.15), i * interval * 1000);
  });
}

// ========== 具体音效 ==========

const Sounds = {
  // 掷骰子
  dice() {
    playSequence([
      { freq: 200, dur: 0.05, type: 'square' },
      { freq: 300, dur: 0.05, type: 'square' },
      { freq: 250, dur: 0.05, type: 'square' },
      { freq: 350, dur: 0.08, type: 'square' },
    ], 0.08);
  },

  // 移动一步
  step() {
    playTone(400, 0.04, 'sine', 0.08);
  },

  // 购买地产
  buy() {
    playSequence([
      { freq: 523, dur: 0.1 },
      { freq: 659, dur: 0.1 },
      { freq: 784, dur: 0.15 },
    ], 0.08);
  },

  // 付租金
  pay() {
    playSequence([
      { freq: 400, dur: 0.1, type: 'sawtooth' },
      { freq: 300, dur: 0.15, type: 'sawtooth' },
    ], 0.1);
  },

  // 拍卖
  auction() {
    playTone(600, 0.1, 'triangle', 0.12);
    setTimeout(() => playTone(800, 0.15, 'triangle', 0.12), 120);
  },

  // 出价
  bid() {
    playTone(880, 0.06, 'sine', 0.1);
  },

  // 抽卡
  card() {
    playSequence([
      { freq: 440, dur: 0.08, type: 'triangle' },
      { freq: 554, dur: 0.08, type: 'triangle' },
      { freq: 659, dur: 0.12, type: 'triangle' },
    ], 0.07);
  },

  // 进监狱
  jail() {
    playSequence([
      { freq: 300, dur: 0.15, type: 'sawtooth', vol: 0.12 },
      { freq: 200, dur: 0.2, type: 'sawtooth', vol: 0.12 },
      { freq: 150, dur: 0.3, type: 'sawtooth', vol: 0.12 },
    ], 0.15);
  },

  // 破产
  bankrupt() {
    playSequence([
      { freq: 400, dur: 0.2, type: 'sawtooth', vol: 0.15 },
      { freq: 300, dur: 0.2, type: 'sawtooth', vol: 0.15 },
      { freq: 200, dur: 0.4, type: 'sawtooth', vol: 0.15 },
    ], 0.2);
  },

  // 胜利
  win() {
    playSequence([
      { freq: 523, dur: 0.12 },
      { freq: 659, dur: 0.12 },
      { freq: 784, dur: 0.12 },
      { freq: 1047, dur: 0.25 },
    ], 0.1);
  },

  // 交易成功
  trade() {
    playSequence([
      { freq: 659, dur: 0.08 },
      { freq: 880, dur: 0.12 },
    ], 0.08);
  },

  // 经过起点
  go() {
    playTone(523, 0.08, 'sine', 0.12);
    setTimeout(() => playTone(784, 0.12, 'sine', 0.12), 80);
  },

  // 建房
  build() {
    playTone(300, 0.06, 'square', 0.1);
    setTimeout(() => playTone(500, 0.1, 'square', 0.1), 60);
  },

  // 错误提示
  error() {
    playTone(200, 0.15, 'sawtooth', 0.1);
  },

  // 系统提示
  notify() {
    playTone(660, 0.08, 'sine', 0.1);
  },
};

window.Sounds = Sounds;
window.toggleSound = toggleSound;
window.isSoundEnabled = isSoundEnabled;
