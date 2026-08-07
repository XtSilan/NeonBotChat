// ── 状态 ────────────────────────────────────────────
let currentConv = null;
let conversations = [];
let lastMsgId = 0;  // 当前会话最后一条消息 ID，用于增量拉取
let ws = null;

const $ = (s) => document.querySelector(s);
const $convList = $('#convList');
const $messages = $('#messages');
const $chatEmpty = $('#chatEmpty');
const $chatHeader = $('#chatHeader');
const $chatName = $('#chatName');
const $chatAvatar = $('#chatAvatar');
const $inputArea = $('#inputArea');
const $msgInput = $('#msgInput');
const $sendBtn = $('#sendBtn');
const $searchInput = $('#searchInput');
const $botStatus = $('#botStatus');

// ── API ─────────────────────────────────────────────
const API = (url, opts = {}) => fetch(url, opts).then(r => r.json());

// ── WebSocket ───────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    console.log('[WS] connected');
    $botStatus.textContent = '● 在线';
    $botStatus.className = 'status';
  };

  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === 'new_message') {
        handleIncomingMessage(data.data);
      } else if (data.type === 'recall_message') {
        handleRecallMessage(data.data);
      } else if (data.type === 'delete_message') {
        handleDeleteMessage(data.data);
      } else if (data.type === 'batch_delete') {
        handleBatchDelete(data.data);
      } else if (data.type === 'clear_all') {
        $messages.innerHTML = '';
        lastMsgId = 0;
        // 重新加载会话列表
        API('/api/conversations').then(d => {
          conversations = d.conversations || [];
          renderConvList($searchInput.value);
        });
      }
    } catch (e) {
      console.warn('[WS] parse error', e);
    }
  };

  ws.onclose = () => {
    $botStatus.textContent = '● 离线';
    $botStatus.className = 'status offline';
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => ws.close();
}

// ── 处理新消息（来自 Bot 或自己发出） ──────────────
let pendingContents = new Set();  // 去重用

// ── 桌面通知 ──────────────────────────────────────────
function notifyNewMessage(msg) {
  if (localStorage.getItem('desktop_notify') !== '1') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const isAt = !!msg.is_at;
  const isCurrent = currentConv === msg.conversation_id;
  if (!isAt && isCurrent) return;  // 正在看的会话不打扰
  const conv = findConvAnywhere(msg.conversation_id);
  const name = conv ? (conv.name || conv.id) : msg.conversation_id;
  const body = (msg.sender_name ? msg.sender_name + ': ' : '') + (msg.content || '[图片/语音]');
  try {
    const n = new Notification(isAt ? `📣 ${name} @了你` : name, {
      body: body.slice(0, 120),
      icon: '/icons/bot.svg',
      tag: msg.conversation_id,  // 同一会话的通知合并
    });
    n.onclick = () => { window.focus(); selectConv(msg.conversation_id); n.close(); };
  } catch (e) { /* 通知失败不影响主流程 */ }
}

function handleIncomingMessage(msg) {
  notifyNewMessage(msg);
  // 隐藏会话收到新消息：不插入会话列表，只更新搜索缓存
  if (msg.conversation_hidden) {
    if (searchResults) {
      const hs = searchResults.find(c => c.id === msg.conversation_id);
      if (hs) {
        hs.last_message = msg.content || '';
        hs.last_sender = msg.sender_name || '';
        hs.last_direction = msg.direction || '';
        hs.unread_count = (hs.unread_count || 0) + (msg.conversation_id !== currentConv && msg.direction !== 'outgoing' ? 1 : 0);
        renderConvList($searchInput.value);
      }
    }
    // 当前正打开它则正常追加消息
    if (currentConv === msg.conversation_id) {
      if (msg.id && document.querySelector(`.msg-row[data-msg-id="${msg.id}"]`)) return;
      if (msg.direction === 'outgoing' && pendingContents.has(msg.content)) return;
      appendMessage(msg, true);
      if (msg.id) lastMsgId = Math.max(lastMsgId, msg.id);
    }
    return;
  }
  // 更新/插入会话列表
  const idx = conversations.findIndex(c => c.id === msg.conversation_id);
  if (idx >= 0) {
    conversations[idx].last_message = msg.content || '';
    conversations[idx].last_sender = msg.sender_name || '';
    conversations[idx].last_direction = msg.direction || '';
    conversations[idx].unread_count = (conversations[idx].unread_count || 0);
    if (msg.conversation_id !== currentConv && msg.direction !== 'outgoing') {
      conversations[idx].unread_count++;
    }
    if (msg.is_at) conversations[idx].at = true;  // @我 标记（打开会话后清除）
    const [item] = conversations.splice(idx, 1);
    conversations.unshift(item);
  } else {
    conversations.unshift({
      id: msg.conversation_id,
      name: msg.conversation_id,
      type: 'group',
      avatar_url: '',
      last_message: msg.content || '',
      last_sender: msg.sender_name || '',
      last_direction: msg.direction || '',
      unread_count: currentConv === msg.conversation_id ? 0 : 1,
      at: !!msg.is_at,
    });
  }
  renderConvList();

  // 如果当前正在看这个会话，追加消息并更新 lastMsgId 防止重复
  if (currentConv === msg.conversation_id) {
    // 乐观更新去重：msg-id 已存在 或 内容正在发送中
    if (msg.id && document.querySelector(`.msg-row[data-msg-id="${msg.id}"]`)) return;
    if (msg.direction === 'outgoing' && pendingContents.has(msg.content)) return;
    appendMessage(msg, true);
    if (msg.id) lastMsgId = Math.max(lastMsgId, msg.id);
  }
}

// ── 渲染会话列表 ────────────────────────────────────
function convPreview(c) {
  if (!c.last_message) return '';
  // 折叠换行/连续空白为单空格，保证预览始终单行省略
  const m = String(c.last_message).replace(/\s+/g, ' ').trim();
  if (!m) return '';
  if (c.last_direction === 'incoming' && c.last_sender) {
    return c.last_sender + ': ' + m;
  }
  return m;
}

let searchResults = null;  // 搜索时含隐藏会话的全量结果

function renderConvList(filter = '') {
  const q = filter.toLowerCase();
  const source = searchResults || conversations;
  const filtered = source.filter(c =>
    !q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)
  ).sort((a, b) => (b.pinned || 0) - (a.pinned || 0));

  $convList.innerHTML = filtered.length === 0
    ? '<div style="padding:20px;color:var(--text-dim);text-align:center;">暂无会话</div>'
    : filtered.map(c => `
      <div class="conv-item${c.id === currentConv ? ' active' : ''}${c.pinned ? ' pinned' : ''}${c.hidden ? ' hidden-item' : ''}"
           data-id="${c.id}" onclick="selectConv('${c.id}')">
        <div class="avatar">${(c.name || c.id)[0]}</div>
        <div class="info">
          <div class="name">${c.at ? '<span class="at-tag">@</span>' : ''}${escHtml(c.name || c.id)}${c.hidden ? '<span style="color:var(--text-dim);font-size:0.75em;margin-left:6px;">(已隐藏)</span>' : ''}</div>
          <div class="preview">${escHtmlWithBr(convPreview(c) || '暂无消息')}</div>
        </div>
        ${c.unread_count ? `<span class="badge${c.muted ? ' muted' : ''}">${c.unread_count > 99 ? '99+' : c.unread_count}</span>` : ''}
      </div>
    `).join('');
}

function icon(name, sz = 18) {
  return `<img src="icons/${name}.svg" class="svg-icon" style="width:${sz}px;height:${sz}px;" alt="">`;
}
function parseQuoteThumbs(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  try { return JSON.parse(data) || []; } catch { return []; }
}
function fmtQuoteContent(content, thumbs) {
  if (!content) return '';
  // 文件消息：显示图标 + 文件名
  const fileMatch = content.match(/^\[文件\]\s+(.+)$/);
  if (fileMatch) {
    const fn = fileMatch[1];
    const ext = (fn || '').split('.').pop().toLowerCase();
    return `<img src="icons/${fileIconName(fn)}.svg" class="svg-icon" style="width:20px;height:20px;" alt=""> ${escHtml(fn)}`;
  }
  // 图片/视频：不显示占位文字，用缩略图代替
  if (['[图片]','[视频]'].includes(content)) return quoteThumbHtml(thumbs);
  return escHtmlWithBr(content) + quoteThumbHtml(thumbs);
}

function quoteThumbHtml(thumbs) {
  const list = parseQuoteThumbs(thumbs);
  if (!list || !list.length) return '';
  return list.map(t => {
    const isDirect = isFileServerUrl(t.url);
    const src = isDirect ? t.url : `/api/image?url=${encodeURIComponent(t.url)}`;
    return `<div class="input-quote-thumb">${t.type === 'image'
      ? `<img src="${escHtml(src)}" style="max-width:56px;max-height:42px;object-fit:contain;border-radius:4px;pointer-events:none;" alt="">`
      : `<video src="${escHtml(src)}" style="max-width:56px;max-height:42px;object-fit:contain;border-radius:4px;pointer-events:none;" muted></video>`
    }</div>`;
  }).join('');
}

function fmtBotMarker(name) {
  // 将名字中的 🤖 替换为 bot.svg 图标
  if (!name) return name;
  return name.replace(/🤖/g, '<img src="icons/bot.svg" class="svg-icon" style="width:14px;height:14px;margin:0 2px;" alt="">');
}
function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function fmtTime(ts) {
  if (!ts) return '';
  // "2026-07-19 16:43:39" → "07-19 16:43"
  const m = ts.match(/^(\d{4}-)?(\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  return m ? m[2] + ' ' + m[3] : ts.substring(0, 16);
}

function escHtmlWithBr(s) {
  return escHtml(s).replace(/\n/g, '<br>');
}

function renderMarkdown(text) {
  if (!text) return '';
  let html = text;
  // LaTeX（katex 可能因 CDN 被墙不可用）
  if (typeof katex !== 'undefined') {
    html = html.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) => {
      try { return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false }); }
      catch { return _; }
    });
    html = html.replace(/\$([^\$]+?)\$/g, (_, tex) => {
      try { return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false }); }
      catch { return _; }
    });
  }
  // 简单 Markdown（每行行首匹配）
  html = html.replace(/^###### ?(.+)/gm, '<h6>$1</h6>');
  html = html.replace(/^##### ?(.+)/gm, '<h5>$1</h5>');
  html = html.replace(/^#### ?(.+)/gm, '<h4>$1</h4>');
  html = html.replace(/^### ?(.+)/gm, '<h3>$1</h3>');
  html = html.replace(/^## ?(.+)/gm, '<h2>$1</h2>');
  html = html.replace(/^# ?(.+)/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

function roleBadge(role) {
  if (role === 'owner' || role === '群主') return '<span class="owner-badge">群主</span>';
  if (role === 'admin' || role === '管理员') return '<span class="admin-badge">管理员</span>';
  return '';
}

// ── 选择会话 ────────────────────────────────────────
async function selectConv(convId, targetMsgId = 0) {
  currentConv = convId;
  $chatEmpty.style.display = 'none';
  $messages.style.display = 'flex';
  $chatHeader.style.display = 'flex';
  $inputArea.style.display = 'flex';
  $msgInput.disabled = false;
  $sendBtn.disabled = false;
  $msgInput.focus();

  // 会话信息
  const conv = findConvAnywhere(convId);
  if (conv) {
    $chatName.textContent = conv.name || conv.id;
    $chatAvatar.textContent = (conv.name || conv.id)[0];
    // 立即清除未读（不等 API）和 @ 标记
    conv.unread_count = 0;
    conv.at = false;
    // 搜索找回的隐藏会话：点进去自动取消隐藏
    if (conv.hidden) {
      API(`/api/conversations/${encodeURIComponent(convId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: false }),
      }).then(() => {
        conv.hidden = 0;
        renderConvList($searchInput.value);
      });
    }
    renderConvList($searchInput.value);
  }

  // 加载历史消息（搜索定位时用 around 加载目标消息周围窗口）
  const data = await API(`/api/messages/${convId}?limit=50${targetMsgId ? `&around=${targetMsgId}` : ''}`);
  $messages.innerHTML = '';
  lastMsgDate = null;  // 重置日期分隔状态
  const msgs = data.messages || [];
  msgs.forEach(m => appendMessage(m, false));
  lastMsgId = msgs.length > 0 ? msgs[msgs.length - 1].id : 0;

  // 搜索定位：滚动到目标消息并高亮
  if (targetMsgId) {
    const el = document.querySelector(`.msg-row[data-msg-id="${targetMsgId}"]`);
    if (el) {
      el.classList.add('hl');
      setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80);
      setTimeout(() => el.classList.remove('hl'), 3000);
    }
  } else {
    // 滚动到底部
    // 手机端：显示聊天区，隐藏侧栏
    if (window.innerWidth <= 768) {
      document.getElementById('chatArea').classList.add('mobile-open');
      document.querySelector('.sidebar').style.display = 'none';
    }
    scrollBottom();
  }
  renderConvList($searchInput.value);
}

// ── 会话搜索 ────────────────────────────────────────
function doConvSearch(q) {
  // 搜索时带上隐藏会话，支持通过备注/OpenID 找回
  API('/api/conversations?include_hidden=1').then(d => {
    searchResults = d.conversations || [];
    renderConvList($searchInput.value);
  });
}

$searchInput.addEventListener('input', () => {
  const q = $searchInput.value.trim();
  if (q) doConvSearch(q);
  else { searchResults = null; renderConvList(''); }
});

// ── 处理 WebSocket 撤回/删除事件 ─────────────────────
function handleRecallMessage(data) {
  const el = document.querySelector(`.msg-row[data-msg-id="${data.id}"]`);
  if (el) {
    const noReedit2 = ['[图片]','[视频]','[语音]','[文件]','[卡片消息]','[键盘]'].some(p => (data.content || '').startsWith(p)) || (data.msg_type == 8);
    el.innerHTML = `<div class="msg-bubble">你撤回了一条消息${noReedit2 ? '' : ` <span class="reedit-link" onclick="reeditMessageContent('${encodeURIComponent(data.content || '')}', ${data.msg_type || 0}, '${data.quoted_ref_idx || ''}', '${(data.quoted_sender || '').replace(/'/g, "\\'")}', '${(data.quoted_content || '').replace(/'/g, "\\'")}')">重新编辑</span>`}</div>`;
    el.classList.add('center');
    el.classList.remove('in', 'out');
    el.removeEventListener('contextmenu', onMsgContextMenu);
  }
  // 更新会话预览
  const conv = conversations.find(c => c.id === data.conversation_id);
  if (conv) {
    conv.last_message = '你撤回了一条消息';
    conv.last_sender = '';
    conv.last_direction = '';
  }
  renderConvList($searchInput.value);
}

function scrollToQuoted(refIdx) {
  if (!refIdx) return;
  const el = document.querySelector(`.msg-row[data-msg-ref-idx="${refIdx}"]`);
  if (!el) { showToast('⚠ 原消息不在当前视图中'); return; }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.style.transition = 'all 0.3s';
  const isLight = document.body.classList.contains('light');
  el.style.backdropFilter = isLight ? 'blur(8px) brightness(0.9)' : 'blur(8px) brightness(1.3)';
  el.style.webkitBackdropFilter = el.style.backdropFilter;
  setTimeout(() => { el.style.backdropFilter = ''; el.style.webkitBackdropFilter = ''; }, 1000);
}

function reeditMessageContent(encoded, msgType, refIdx, quotedSender, quotedContent) {
  const content = decodeURIComponent(encoded || '');
  $msgInput.value = content;
  $('#mdCheckbox').checked = (msgType === 2);
  updateMdToggle();
  // 恢复引用
  if (refIdx) {
    currentQuoteRef = { message_id: refIdx, quoted_sender: quotedSender || '', quoted_content: quotedContent || '', thumbs: [] };
    $('#inputQuoteSender').textContent = quotedSender || '';
    $('#inputQuoteText').innerHTML = (quotedContent || '');
    $('#inputQuoteBar').style.display = 'flex';
  } else {
    currentQuoteRef = null;
    $('#inputQuoteBar').style.display = 'none';
  }
  $msgInput.focus();
  $msgInput.style.height = 'auto';
  $msgInput.style.height = Math.min($msgInput.scrollHeight, 120) + 'px';
  $msgInput.scrollIntoView({ behavior: 'smooth' });
}

async function handleDeleteMessage(data) {
  const el = document.querySelector(`.msg-row[data-msg-id="${data.id}"]`);
  if (el) el.remove();
  // 刷新会话列表（后端已更新 last_message）
  try {
    const r = await API('/api/conversations');
    conversations = r.conversations || [];
    renderConvList($searchInput.value);
  } catch (e) {}
}

async function handleBatchDelete(data) {
  (data.ids || []).forEach(id => {
    const el = document.querySelector(`.msg-row[data-msg-id="${id}"]`);
    if (el) el.remove();
  });
  // 刷新会话列表
  try {
    const r = await API('/api/conversations');
    conversations = r.conversations || [];
    renderConvList($searchInput.value);
  } catch (e) {}
}

// ── 刷新 ────────────────────────────────────────────
async function refreshConversations(silent = false) {
  try {
    const data = await API('/api/conversations');
    const newList = data.conversations || [];
    // 保留本地未读数（API 会重置为 0）
    newList.forEach(c => {
      const old = conversations.find(o => o.id === c.id);
      if (old && old.unread_count > 0 && c.id !== currentConv) {
        c.unread_count = old.unread_count;
      }
    });
    conversations = newList;
    renderConvList($searchInput.value);

    // 如果打开了会话，增量拉取新消息
    if (currentConv && lastMsgId > 0) {
      const msgData = await API(`/api/messages/${currentConv}?limit=50`);
      const msgs = msgData.messages || [];
      // 只追加 lastMsgId 之后的新消息
      const newMsgs = msgs.filter(m => m.id > lastMsgId);
      newMsgs.forEach(m => appendMessage(m, true));
      if (newMsgs.length > 0) {
        lastMsgId = newMsgs[newMsgs.length - 1].id;
        if (!silent) scrollBottom();
      }
    }
  } catch (e) {
    console.error('刷新失败', e);
  }
}

// 每 5 秒自动刷新
let refreshTimer = null;
refreshTimer = setInterval(() => refreshConversations(true), 5000);

// ── 初始化 ──────────────────────────────────────────
async function init() {
  // 先加载服务器设置
  await loadServerSettings();
  // 应用主题（客户端独立）
  setTheme(localStorage.getItem('neonbot_theme') || 'dark');
  // 应用背景（客户端独立）
  applyBg();
  // 应用头像
  applyBotAvatar();
  // 渲染简介
  renderBio();

  connectWS();
  await refreshConversations(false);
  // 首页统计看板
  loadHomeStats();
  // 获取 Bot 名称
  try {
    const info = await API('/api/system-info');
    botDisplayName = (info.bot_name || 'Bot');
    updateAccountBotName();
  } catch (e) {}
}
// ⚠️ init() 调用在 settings.js 末尾执行——它依赖 settings.js 中的函数，须等全部文件加载完

init();
