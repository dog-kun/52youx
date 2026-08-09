// ========== 前后端分离配置 ==========
// 本地测试：默认指向本地后端（start.bat 启动的后端服务，端口 3000）
// 服务器部署：把你的后端地址填到 BACKEND_URL
// CF Pages 部署：改为后端域名，例如 'https://api.yourdomain.com'
const BACKEND_URL = 'http://202.189.23.245:48935';

// 封装 fetch：自动加上后端地址 + 携带跨域 Cookie
async function apiFetch(url, options = {}) {
  options.credentials = 'include';
  return fetch(BACKEND_URL + url, options);
}

// 封装 Socket.io 连接：自动加上后端地址 + 跨域凭证
function connectSocket(namespace = '') {
  return io(BACKEND_URL + namespace, {
    withCredentials: true,
    transports: ['websocket', 'polling'],
  });
}
