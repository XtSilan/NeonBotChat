// ── 状态 ────────────────────────────────────────────
let currentConv = null;
let currentConvType = 'group';  // 'group' | 'direct'（私聊）
let conversations = [];
let lastMsgId = 0;  // 当前会话最后一条消息 ID，用于增量拉取
let ws = null;

const $ = (s) => document.querySelector(s);
const $convList = $('#convList');
const $messages = $('#messages');
const $chatEmpty = $('#chatEmpty');
const $chatHeader = $('#chatHeader');
const $chatName = $('#chatName');
const $chatNameInner = $('#chatNameInner');
const $chatAvatar = $('#chatAvatar');
const $inputArea = $('#inputArea');
const $msgInput = $('#msgInput');
const $sendBtn = $('#sendBtn');
const $searchInput = $('#searchInput');

// ── API ─────────────────────────────────────────────
const API = (url, opts = {}) => fetch(url, opts).then(r => r.json());

// ── WebSocket ───────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    console.log('[WS] connected');
    $('#railStatusDot').style.background = 'var(--online)';
    $('#mobileStatusDot').style.background = 'var(--online)';  // 移动端顶栏在线点
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
      } else if (data.type === 'join_request') {
        handleJoinRequestPush(data.data);
      }
    } catch (e) {
      console.warn('[WS] parse error', e);
    }
  };

  ws.onclose = () => {
    $('#railStatusDot').style.background = 'var(--danger)';
    $('#mobileStatusDot').style.background = 'var(--danger)';
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
  const name = conv ? (conv.display_name || conv.name || conv.id) : msg.conversation_id;
  // 私聊不显示发送者 openid 前缀
  const senderLabel = msg.conv_type === 'direct' ? '' : (msg.sender_name ? msg.sender_name + ': ' : '');
  const body = senderLabel + (msg.content || '[图片/语音]');
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
  // 系统消息（direction=center，如「XXX加入了群聊。」）不弹桌面通知
  if (msg.direction !== 'center') notifyNewMessage(msg);
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
      type: msg.conv_type === 'direct' ? 'direct' : 'group',
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
  // 转发消息（聊天记录）预览统一显示 [聊天记录]（旧数据兜底，新数据由后端归一化）
  if (m.startsWith('[群聊的聊天记录]') || m.startsWith('[好友的聊天记录]')) return '[聊天记录]';
  if (c.last_direction === 'center' && c.last_sender) {
    return c.last_sender + m;  // 系统气泡（禁言等）：名字内容，无空格
  }
  if (c.last_direction === 'incoming' && c.last_sender) {
    if (c.type === 'direct') return m;  // 私聊不显示发送者 openid
    return c.last_sender + ': ' + m;
  }
  return m;
}

let searchResults = null;  // 搜索时含隐藏会话的全量结果

function renderConvList(filter = '') {
  const q = filter.toLowerCase();
  const source = searchResults || conversations;
  const filtered = source.filter(c =>
    !q || (c.display_name || c.name || '').toLowerCase().includes(q) || c.id.toLowerCase().includes(q)
  ).sort((a, b) => (b.pinned || 0) - (a.pinned || 0));

  $convList.innerHTML = filtered.length === 0
    ? '<div style="padding:20px;color:var(--text-dim);text-align:center;">暂无会话</div>'
    : filtered.map(c => `
      <div class="conv-item${c.id === currentConv ? ' active' : ''}${c.pinned ? ' pinned' : ''}${c.hidden ? ' hidden-item' : ''}"
           data-id="${c.id}" onclick="selectConv('${c.id}')">
        <div class="avatar">${c.avatar_url ? `<img src="${escHtml(c.avatar_url)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" onerror="this.style.display='none'">` : `${(c.display_name || c.name || c.id)[0]}`}</div>
        <div class="info">
          <div class="name">${c.at ? '<span class="at-tag">@</span>' : ''}${escHtml(c.display_name || c.name || c.id)}${c.hidden ? '<span style="color:var(--text-dim);font-size:0.75em;margin-left:6px;">(已隐藏)</span>' : ''}</div>
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

// 群信息返回机器人身份后，回填所有已渲染的机器人消息徽章（.bot-role-badge 占位）
function applyBotRoleBadge(role) {
  const html = roleBadge(role);
  document.querySelectorAll('.bot-role-badge').forEach(el => { el.innerHTML = html; });
}

// 顶栏下方常驻提示：recv_setting 已知且非 all 时显示（不自动关闭，退出群聊/私聊时隐藏）
// 手动关闭后本会话内不再显示（刷新页面重置）；进群时随群信息检查结果更新
const dismissedRecvWarn = new Set();
function updateRecvBanner(conv) {
  const show = !!(conv && conv.type === 'group' && conv.recv_setting && conv.recv_setting !== 'all'
                  && !dismissedRecvWarn.has(conv.id));
  $('#recvWarnBanner').style.display = show ? 'flex' : 'none';
}
$('#recvWarnClose').addEventListener('click', () => {
  if (currentConv) dismissedRecvWarn.add(currentConv);
  $('#recvWarnBanner').style.display = 'none';
});

// ── 选择会话 ────────────────────────────────────────
// ── 聊天区切换动画 ──────────────────────────────────
// fromEl 向上收（覆盖层滑出），toEl 向下展开
function transitionChat(fromEl, toEl) {
  fromEl.style.position = 'absolute';
  fromEl.style.inset = '0';
  fromEl.style.zIndex = '2';
  fromEl.classList.add('anim-slide-up');
  toEl.style.display = 'flex';
  toEl.classList.add('anim-slide-down');
  setTimeout(() => {
    fromEl.style.display = 'none';
    fromEl.style.position = '';
    fromEl.style.inset = '';
    fromEl.style.zIndex = '';
    fromEl.classList.remove('anim-slide-up');
    toEl.classList.remove('anim-slide-down');
  }, 260);
}

// ── 视图模式：主页（沉浸式看板）/ 消息（聊天界面）───
let viewMode = 'chat';

function showHomeView(skipAnim) {
  viewMode = 'home';
  currentConv = '';
  hideJumpBtn();  // 回主页清掉「跳至最新消息」按钮与计数
  // 沉浸式：主侧栏向左滑出（覆盖层动画，动画结束再移除），侧侧栏保留
  const sb = document.querySelector('.sidebar');
  if (sb.style.display !== 'none' && !skipAnim) {
    sb.style.position = 'absolute';
    sb.style.left = '0';
    sb.style.top = '0';
    sb.style.bottom = '0';
    sb.style.zIndex = '4';  // 低于侧侧栏(5)，滑出时从侧侧栏底下经过
    sb.classList.add('anim-sidebar-out');
    setTimeout(() => {
      sb.style.display = 'none';
      sb.style.position = '';
      sb.style.left = '';
      sb.style.top = '';
      sb.style.bottom = '';
      sb.style.zIndex = '';
      sb.classList.remove('anim-sidebar-out');
    }, 260);
  } else {
    sb.style.display = 'none';  // 首次加载：直接隐藏无动画
  }
  $('#homeStats').style.display = '';
  // 手机端：主页模式同样显示聊天区（统计看板），否则 .chat-area 在移动端是 display:none
  // （进入聊天时有 mobile-open，主页此前漏了 → 统计卡片直接消失）
  // home-mode：卡片不盖侧栏（从窄栏右侧开始）+ 窄屏横滑浏览
  if (window.innerWidth <= 768) {
    const ca = document.getElementById('chatArea');
    ca.classList.add('mobile-open');
    ca.classList.add('home-mode');
  }
  loadHomeStats();
  $('#chatEmptyHint').style.display = 'none';
  $('#btnExportReport').style.display = '';  // 主页模式显示导出周报
  $('#railHomeBtn').classList.add('active');
  $('#railMsgBtn').classList.remove('active');
  // 切换动画：聊天区向上收，看板弹出
  if ($messages.style.display !== 'none') transitionChat($messages, $chatEmpty);
  else {
    $chatEmpty.style.display = 'flex';
    $chatEmpty.classList.add('anim-slide-down');
    setTimeout(() => $chatEmpty.classList.remove('anim-slide-down'), 300);
  }
  $chatHeader.style.display = 'none';
  $inputArea.style.display = 'none';
  $msgInput.disabled = true;
  $sendBtn.disabled = true;
  syncMobileTab();  // 移动端底栏高亮切到「主页」
}

function showChatView(skipAnim) {
  viewMode = 'chat';
  currentConv = '';
  document.getElementById('chatArea').classList.remove('home-mode');  // 主页模式样式（横滑/不盖侧栏）
  renderConvList($searchInput.value);  // 清除会话高亮
  // 恢复两侧栏（含侧侧栏，手机端进入聊天时可能被隐藏）
  document.querySelectorAll('.sidebar, .side-rail').forEach(el => el.style.display = '');
  // 主侧栏直接显示（无滑入动画）
  const sb = document.querySelector('.sidebar');
  sb.style.display = '';
  $('#homeStats').style.display = 'none';
  $('#chatEmptyHint').style.display = 'flex';
  $('#btnExportReport').style.display = 'none';
  $('#railMsgBtn').classList.add('active');
  $('#railHomeBtn').classList.remove('active');
  // 切换动画：看板/聊天区向上收，回到「选择一个聊天」弹出
  if ($messages.style.display !== 'none') transitionChat($messages, $chatEmpty);
  else {
    $chatEmpty.style.display = 'flex';
    $chatEmpty.classList.add('anim-slide-down');
    setTimeout(() => $chatEmpty.classList.remove('anim-slide-down'), 300);
  }
  $chatHeader.style.display = 'none';
  $inputArea.style.display = 'none';
  $msgInput.disabled = true;
  $sendBtn.disabled = true;
  // 手机端：退出全屏聊天
  if (window.innerWidth <= 768) {
    document.getElementById('chatArea').classList.remove('mobile-open');
  }
  syncMobileTab();  // 移动端底栏高亮切到「消息」
}

// 删除聊天/隐藏会话后回到聊天视图
function closeChatToHome() { showChatView(); }

$('#railHomeBtn').addEventListener('click', showHomeView);
$('#railMsgBtn').addEventListener('click', showChatView);
$('#railMsgBtn').classList.add('active');  // 初始默认消息视图

// ── 移动端底栏页面切换（主页/消息/收藏/设置） ────────────
function setMobileTab(tab) {
  document.querySelectorAll('.mb-tab').forEach(el => el.classList.toggle('active', el.dataset.page === tab));
}
// 根据当前 UI 状态同步底栏高亮：收藏/设置页面打开时高亮对应页签，否则回到主页/消息
function syncMobileTab() {
  if ($('#pageFav').classList.contains('open')) return setMobileTab('fav');
  if ($('#pageSettings').classList.contains('open')) return setMobileTab('set');
  setMobileTab(viewMode === 'home' ? 'home' : 'msg');
}
// 切换页面时关掉收藏/设置页面（底栏页签之间的互斥；openFav/openSettings 在 settings.js 定义）
function closeMobilePages() {
  $('#pageFav').classList.remove('open');
  $('#pageSettings').classList.remove('open');
  restoreMobilePageBack();  // 页面关闭：恢复被隐藏的消息/主页（没有页面开着时零开销）
}
// 打开收藏/设置页面前，把底下的消息/主页元素隐藏——毛玻璃直接糊在背景上，
// 而不是糊在会话列表/看板内容上；关闭时按原样恢复（记录当时的显示状态）
let mobileBackState = null;
function hideMobilePageBack() {
  if (window.innerWidth > 768) return;
  const ca = document.getElementById('chatArea');
  mobileBackState = {
    sidebar: document.querySelector('.sidebar').style.display,  // ''（可见）或 'none'
    chatOpen: ca.classList.contains('mobile-open') && !ca.classList.contains('home-mode'),
    homeMode: ca.classList.contains('home-mode')
  };
  document.querySelector('.sidebar').style.display = 'none';
  ca.classList.remove('mobile-open', 'home-mode');
}
function restoreMobilePageBack() {
  if (window.innerWidth > 768 || !mobileBackState) return;
  const sb = document.querySelector('.sidebar');
  const ca = document.getElementById('chatArea');
  sb.style.display = mobileBackState.sidebar;
  if (mobileBackState.homeMode) ca.classList.add('mobile-open', 'home-mode');
  else if (mobileBackState.chatOpen) ca.classList.add('mobile-open');
  mobileBackState = null;
}
document.querySelectorAll('.mb-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    // 先记住当前页签是否已打开（用于再点一次关闭），再统一关掉收藏/设置页——
    // 否则切到主页/消息时旧页还盖在上面，看起来像"点不动"
    const wasOpen = page === 'fav'
      ? $('#pageFav').classList.contains('open')
      : page === 'set' ? $('#pageSettings').classList.contains('open') : false;
    closeMobilePages();
    if (page === 'home') showHomeView();
    else if (page === 'msg') showChatView();
    else if (page === 'fav' && !wasOpen) openFav();
    else if (page === 'set' && !wasOpen) openSettings();
    syncMobileTab();
  });
});
syncMobileTab();  // 初始高亮「消息」（default_view=home 时 showHomeView 会再切到「主页」）

// 聊天顶栏头像（有群头像显示图片，否则首字母）
// 会话标题：显示名（备注>官方群名>旧名）+ 群人数
function fmtConvTitle(conv) {
  let n = conv.display_name || conv.name || conv.id;
  if (conv.type === 'group' && conv.member_num > 0) n += ` (${conv.member_num})`;
  return n;
}

// ── 群信息卡片（点击聊天头群名弹出） ────────────────
const $groupInfoCard = $('#groupInfoCard');

// group_tags 可能是数组（/api/group-info 缓存）或 JSON 字符串（会话列表），统一解析成数组
function parseGroupTags(t) {
  if (Array.isArray(t)) return t;
  if (typeof t === 'string') {
    try {
      const a = JSON.parse(t);
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }
  return [];
}

function renderGroupInfoCard(conv) {
  // 第一行：群名（不带人数）
  $('#gicName').textContent = conv.display_name || conv.name || conv.id;
  // 第二行：完整 OpenID + (N人)
  const oid = conv.id || '';
  $('#gicId').textContent = `${oid}${conv.member_num > 0 ? `(${conv.member_num}人)` : ''}`;
  const av = conv.avatar_url || '';
  if (av) {
    $('#gicAvatar').innerHTML = `<img src="${escHtml(av)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" onerror="this.style.display='none'">`;
  } else {
    $('#gicAvatar').textContent = (conv.display_name || conv.name || conv.id)[0];
  }
  // 全部群标签
  const tags = parseGroupTags(conv.group_tags);
  $('#gicTags').innerHTML = tags.map(t => `<span class="gic-tag">${escHtml(t)}</span>`).join('');
  $('#gicTags').style.display = tags.length ? '' : 'none';
  // 群简介 / 群分类
  const memo = conv.group_memo || '';
  const memoEl = $('#gicMemo');
  const memoTrunc = memo.length > 20;  // 超过 20 字截断，点击弹窗看完整内容
  memoEl.textContent = memoTrunc ? memo.slice(0, 20) + '……' : (memo || '暂无简介');
  memoEl.classList.toggle('memo-trunc', memoTrunc);
  memoEl.dataset.full = memo;
  $('#gicClass').textContent = conv.group_class || '暂无分类';
}

// 点击截断的群简介 → 二次弹窗显示完整内容
$('#gicMemo').addEventListener('click', () => {
  const memoEl = $('#gicMemo');
  if (!memoEl.classList.contains('memo-trunc')) return;  // 未截断（内容已完整显示）不弹窗
  $('#memoFull').textContent = memoEl.dataset.full || '';
  $('#memoModal').classList.add('show');
});
$('#btnCloseMemo').addEventListener('click', () => $('#memoModal').classList.remove('show'));
$('#memoModal').addEventListener('click', (e) => { if (e.target === $('#memoModal')) $('#memoModal').classList.remove('show'); });

function hideGroupInfoCard() {
  $groupInfoCard.style.display = 'none';
  $chatName.classList.remove('card-open');
}

function toggleGroupInfoCard() {
  const conv = findConvAnywhere(currentConv);
  if (!conv || conv.type !== 'group') return;  // 仅群聊可弹
  if ($groupInfoCard.style.display !== 'none') { hideGroupInfoCard(); return; }
  renderGroupInfoCard(conv);
  $groupInfoCard.style.display = 'block';
  $chatName.classList.add('card-open');
  // 数据不全则补拉一次（缓存命中则不重复请求）
  if (!conv.group_memo && !conv.group_class && !parseGroupTags(conv.group_tags).length) {
    API(`/api/group-info/${encodeURIComponent(currentConv)}`).then(r => {
      if (r && r.ok) {
        conv.group_memo = r.memo || '';
        conv.group_class = r.class_text || '';
        conv.group_tags = r.tags || [];
        renderGroupInfoCard(conv);
      }
    }).catch(() => {});
  }
}

$chatNameInner.addEventListener('click', (e) => {
  if (currentConvType === 'direct') {
    // 私聊：点用户名 = 点对方头像，直接弹成员卡片（名字/头像用会话显示名兜底）；
    // 锚定卡片已开时再点一次 = 关闭（与群卡片 toggle 一致）
    const $mc = $('#memberCard');
    if ($mc && $mc.style.display !== 'none' && $mc.dataset.anchored === '1') {
      hideMemberCard();
      e.stopPropagation();
      return;
    }
    const conv = findConvAnywhere(currentConv);
    if (!conv) return;
    hideGroupInfoCard();
    showMemberCard(e, currentConv,
      senderDisplayName(conv.display_name || conv.name || conv.id, currentConv),
      conv.avatar_url || '', false, true);
    e.stopPropagation();  // 阻止 document 点击监听立即关闭卡片
    return;
  }
  toggleGroupInfoCard();
});
document.addEventListener('click', (e) => {
  if ($groupInfoCard.style.display === 'none') return;
  // 点击群名文本或卡片内部不关闭（外层空白区不算）
  if ($chatNameInner.contains(e.target) || $groupInfoCard.contains(e.target)) return;
  hideGroupInfoCard();
});

function applyChatHeaderAvatar() {
  const conv = findConvAnywhere(currentConv);
  if (!conv) return;
  if (conv.avatar_url) {
    $chatAvatar.innerHTML = `<img src="${escHtml(conv.avatar_url)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" onerror="this.style.display='none'">`;
  } else {
    $chatAvatar.textContent = (conv.display_name || conv.name || conv.id)[0];
  }
}

async function selectConv(convId, targetMsgId = 0) {
  currentConv = convId;
  hideJumpBtn();  // 切换会话清掉「跳至最新消息」按钮与计数
  closeMobilePages();  // 进入会话时收掉收藏/设置页面（如通知直跳等路径）
  hideGroupInfoCard();
  hideMemberCard();  // 切换会话关闭成员卡片
  const convNow = findConvAnywhere(convId);
  currentConvType = convNow && convNow.type ? convNow.type : 'group';
  // 加群申请入口：仅机器人是当前群管理员/群主时显示；红点按当前群计数刷新
  updateJoinReqBtnVisibility();
  refreshJoinReqBadge();
  // 私聊/群聊标题都可点击（群聊弹群信息卡片，私聊弹用户信息卡片）
  // 禁言状态 1s 轮询：仅群聊轮询，切换会话即停
  stopMutePolling();
  stopJoinReqPolling();
  if (convNow && convNow.type === 'group') {
    startMutePolling(convId);
    startJoinReqPolling();
  }
  // 进入动画：主页看板向上收，聊天区向下展开
  if ($chatEmpty.style.display !== 'none') transitionChat($chatEmpty, $messages);
  else $messages.style.display = 'flex';
  $chatHeader.style.display = 'flex';
  $inputArea.style.display = 'flex';
  $msgInput.disabled = false;
  $sendBtn.disabled = false;
  $msgInput.focus();

  // 会话信息
  const conv = findConvAnywhere(convId);
  if (conv) {
    $chatNameInner.textContent = fmtConvTitle(conv);
    applyChatHeaderAvatar();
    // 收消息权限提示（群聊且有值时显示，私聊/未知隐藏）
    updateRecvBanner(conv);
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
    // 群聊：拉取官方群名/人数（后端 24h 缓存，备注优先于官方名）
    // 响应回来时用户可能已切到别的会话：currentConv 不一致则丢弃，防止旧会话的标题/徽章盖掉当前会话
    if (conv.type === 'group') {
      API(`/api/group-info/${encodeURIComponent(convId)}`).then(r => {
        if (r && r.ok && currentConv === convId) {
          conv.official_name = r.official_name || '';
          conv.member_num = r.member_num || 0;
          conv.group_memo = r.memo || '';
          conv.group_class = r.class_text || '';
          conv.group_tags = r.tags || [];
          conv.bot_role = r.bot_role || '';
          // group-info 有 6h 缓存，只信真实值（0/1），-1 未知不覆盖；列表里的新值优先
          if (r.proactive_msg === 0 || r.proactive_msg === 1) conv.proactive_msg = r.proactive_msg;
          if (r.recv_setting) conv.recv_setting = r.recv_setting;
          if (r.display_name) conv.display_name = r.display_name;
          $chatNameInner.textContent = fmtConvTitle(conv);
          renderConvList($searchInput.value);
          // 机器人身份已获取：回填已渲染消息的身份徽章
          applyBotRoleBadge(conv.bot_role);
          // 机器人身份已获取：按身份刷新加群申请入口显隐
          updateJoinReqBtnVisibility();
          // 收消息设置已获取：更新顶栏下方常驻提示
          updateRecvBanner(conv);
          // 卡片已打开则刷新内容
          if ($groupInfoCard.style.display !== 'none') renderGroupInfoCard(conv);
        }
      }).catch(() => {});
    }
    // 私聊：进入页面刷新一次个人头像（失败静默保留旧头像；已切走则不更新界面）
    if (conv.type === 'direct') {
      API(`/api/avatar/${encodeURIComponent(convId)}`).then(r => {
        if (r && r.ok && r.avatar && currentConv === convId) {
          conv.avatar_url = r.avatar;
          applyChatHeaderAvatar();
          renderConvList($searchInput.value);
          // 更新已渲染的对方消息头像（.in 行；自己发的用 bot 头像不受影响）
          document.querySelectorAll('#messages .msg-row.in .msg-avatar-col img.msg-avatar-img').forEach(img => { img.src = r.avatar; });
        }
      }).catch(() => {});
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
      const ca = document.getElementById('chatArea');
      ca.classList.add('mobile-open');
      ca.classList.remove('home-mode');  // 离开主页模式（聊天视图全屏盖侧栏）
      document.querySelectorAll('.sidebar, .side-rail').forEach(el => el.style.display = 'none');
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
    // 撤回自己的消息显示「你撤回了一条消息」+ 重新编辑；撤回别人的显示「你撤回了成员 XXX 的一条消息」
    const isOwn = data.direction === 'outgoing';
    const noReedit2 = !isOwn || ['[图片]','[视频]','[语音]','[文件]','[卡片消息]','[键盘]'].some(p => (data.content || '').startsWith(p)) || (data.msg_type == 8);
    const recallTip = isOwn ? '你撤回了一条消息'
      : `你撤回了成员<span class="mute-member-name">${escHtml(data.sender_name || '')}</span>的一条消息`;
    el.innerHTML = `<div class="msg-bubble">${recallTip}${noReedit2 ? '' : ` <span class="reedit-link" onclick="reeditMessageContent('${encodeURIComponent(data.content || '')}', ${data.msg_type || 0}, '${data.quoted_ref_idx || ''}', '${(data.quoted_sender || '').replace(/'/g, "\\'")}', '${(data.quoted_content || '').replace(/'/g, "\\'")}')">重新编辑</span>`}</div>`;
    el.classList.add('center');
    el.classList.remove('in', 'out');
    el.removeEventListener('contextmenu', onMsgContextMenu);
  }
  // 会话预览：用后端算好的最新预览即时更新（最新未撤回消息，或撤回提示），避免固定文案/跳变
  if (data.preview) {
    const conv = conversations.find(c => c.id === data.conversation_id);
    if (conv) {
      conv.last_message = data.preview.last_message;
      conv.last_sender = data.preview.last_sender;
      conv.last_direction = data.preview.last_direction;
      renderConvList($searchInput.value);
    }
  }
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
    // 会话列表刷新（含 bot_role 变化）→ 同步按钮显隐与红点计数
    updateJoinReqBtnVisibility();
    refreshJoinReqBadge();

    // 如果打开了会话，增量拉取新消息
    if (currentConv && lastMsgId > 0) {
      const msgData = await API(`/api/messages/${currentConv}?limit=50`);
      const msgs = msgData.messages || [];
      // 只追加 lastMsgId 之后的新消息（已渲染过的 id 跳过，防止本地气泡与库中消息双重回显）
      const newMsgs = msgs.filter(m => m.id > lastMsgId);
      newMsgs.forEach(m => {
        if (m.id && document.querySelector(`.msg-row[data-msg-id="${m.id}"]`)) return;
        appendMessage(m, true);
      });
      if (newMsgs.length > 0) {
        lastMsgId = newMsgs[newMsgs.length - 1].id;
        // 滚动交给 appendMessage 里的 autoScrollMsg 按需处理（在底部才滚，翻阅中弹按钮）
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
  // 应用自定义主题色（客户端独立）
  applyAccent(localStorage.getItem('neonbot_accent') || '');
  // 应用背景（客户端独立）
  applyBg();
  // 应用头像
  applyBotAvatar();
  // 渲染简介
  renderBio();
  // 加群申请徽章（红点数量）
  refreshJoinReqBadge();

  connectWS();
  await refreshConversations(false);
  // 获取 Bot 名称
  try {
    const info = await API('/api/system-info');
    botDisplayName = (info.bot_name || 'Bot');
    updateAccountBotName();
  } catch (e) {}
}
// ⚠️ init() 调用在 settings.js 末尾执行——它依赖 settings.js 中的函数，须等全部文件加载完（这里不能再调用！）

// ── 加群申请：查看 + 手动审批 ─────────────────────────
// 进入群聊后每 1s 轮询一次（与禁言一致）：刷新红点计数；弹窗开着时顺带刷列表。
// 后端有 2s 缓存兜底（QQ API 30 QPM），轮询本身只打本地内存 summary 接口。
let joinReqPollTimer = null;

function stopJoinReqPolling() {
  if (joinReqPollTimer) { clearInterval(joinReqPollTimer); joinReqPollTimer = null; }
}

async function joinReqPollTick() {
  refreshJoinReqBadge();
  // 弹窗开着且是当前群 → 刷新列表
  if ($('#joinRequestModal').classList.contains('show')) loadJoinRequests();
}

function startJoinReqPolling() {
  stopJoinReqPolling();
  joinReqPollTick();
  joinReqPollTimer = setInterval(joinReqPollTick, 1000);
}

function fmtRFC3339(ts) {
  // "2026-08-13T12:34:56+08:00" → "08-13 12:34"（本地时区）
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts).substring(0, 16);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function updateJoinReqBtnVisibility() {
  // 机器人不是当前群管理员/群主（或私聊）→ 隐藏加群申请入口
  const btn = $('#btnJoinRequests');
  if (!btn) return;
  let show = false;
  if (currentConvType === 'group') {
    const conv = findConvAnywhere(currentConv);
    const role = conv && conv.bot_role;
    if (['admin', 'owner'].includes(role)) show = true;
  }
  btn.style.display = show ? '' : 'none';
}

function openJoinRequestModal() {
  const conv = findConvAnywhere(currentConv);
  $('#joinRequestGroupName').textContent = conv ? ` · ${conv.display_name || conv.name || conv.id}` : '';
  $('#joinRequestModal').classList.add('show');
  loadJoinRequests();
}

function closeJoinRequestModal() {
  $('#joinRequestModal').classList.remove('show');
}

$('#btnJoinRequests').addEventListener('click', () => {
  if (currentConvType !== 'group') {
    showToast('私聊没有加群申请');
    return;
  }
  const conv = findConvAnywhere(currentConv);
  if (conv && conv.bot_role && !['admin', 'owner'].includes(conv.bot_role)) {
    showToast('机器人不是群管理员，无法查看');
    return;
  }
  openJoinRequestModal();
});

$('#btnCloseJoinRequest').addEventListener('click', closeJoinRequestModal);
$('#joinRequestModal').addEventListener('click', (e) => {
  if (e.target === $('#joinRequestModal')) closeJoinRequestModal();
});

async function loadJoinRequests() {
  if (!currentConv || currentConvType !== 'group') return;
  if (!$('#joinRequestModal').classList.contains('show')) return;
  try {
    const data = await API('/api/join-requests/' + encodeURIComponent(currentConv));
    if (!data.ok) { showToast(data.error || '获取加群申请失败'); return; }
    renderJoinRequests(data.requests || []);
  } catch (e) {
    showToast('获取加群申请失败');
  }
}

function renderJoinRequests(reqs) {
  const box = $('#joinRequestList');
  if (!reqs.length) {
    box.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:24px;">暂无待审批的加群申请</div>';
    return;
  }
  box.innerHTML = reqs.map((r, i) => {
    const name = escHtml(r.username || '未知成员');
    const openid = escHtml(r.member_openid || '');
    const time = fmtRFC3339(r.apply_at);
    const source = r.apply_source === 'invited' ? '被邀请' : '主动申请';
    const risk = r.risk_tips ? `<div class="join-risk">⚠ ${escHtml(r.risk_tips)}</div>` : '';
    const verifyMsg = (r.verify_info && r.verify_info.verify_message)
      ? `<div class="join-verify">验证消息：${escHtml(r.verify_info.verify_message)}</div>` : '';
    // 头像：后端已用 PatchUserInfo.getUserAvatar 下载转 base64 data URL；失败回退首字符
    const avatar = r.avatar
      ? `<img class="jr-avatar" src="${escHtml(r.avatar)}" alt="">`
      : `<div class="jr-avatar">${escHtml((r.username || '?')[0])}</div>`;
    return `
      <div class="join-request-item" data-i="${i}">
        ${avatar}
        <div class="jr-info">
          <div class="jr-name">${name}${risk}</div>
          <div class="jr-sub">OpenID: ${openid}</div>
          <div class="jr-sub">${time} · ${source}</div>
          ${verifyMsg}
        </div>
        <div class="jr-actions">
          <button class="glass-btn active jr-approve">同意</button>
          <button class="glass-btn danger jr-decline">拒绝</button>
        </div>
      </div>`;
  }).join('');
  box.querySelectorAll('.join-request-item').forEach(item => {
    const r = reqs[+item.dataset.i];
    item.querySelector('.jr-approve').onclick = () => approveJoinRequest(r, 'approve');
    item.querySelector('.jr-decline').onclick = () => approveJoinRequest(r, 'decline');
  });
}

async function approveJoinRequest(r, op) {
  const name = r.username || r.member_openid || '该成员';
  let confirmed, rejectReason = '';
  if (op === 'approve') {
    confirmed = await showConfirm(`同意「${name}」加入该群？`, 'ok', false, true);
  } else {
    // 拒绝：可填写原因（可选），第三按钮「拒绝并拉黑」
    const res = await showConfirm(`确定拒绝「${name}」的加群申请？`, 'warning', true, true, '拒绝并拉黑', '', '', '拒绝原因（可选）');
    if (!res) return;
    confirmed = res.action === 'third' ? 'third' : true;
    rejectReason = (res.reason || '').trim();
  }
  if (!confirmed) return;
  try {
    const data = await fetch('/api/join-request/approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conv_id: currentConv,
        member_openid: r.member_openid,
        join_request_id: r.join_request_id,
        op,
        username: r.username || '',
        reject_reason: rejectReason,
        add_to_blacklist: confirmed === 'third',
      }),
    }).then(r => r.json());
    if (!data.ok) { showToast(data.error || '审批失败'); return; }
    showToast(op === 'approve'
      ? '✅ 已同意加入'
      : `✅ 已拒绝加入${confirmed === 'third' ? '，并已拉黑' : ''}`);
    loadJoinRequests();
    refreshJoinReqBadge();
  } catch (e) {
    showToast('审批请求失败');
  }
}

async function refreshJoinReqBadge() {
  // 红点显示「当前会话所在群」的待审批申请数：切换群时数量随之刷新（弹窗也只列当前群）
  try {
    const data = await API('/api/join-requests/summary');
    if (!data.ok) return;
    const badge = $('#btnJoinReqBadge');
    if (!badge) return;
    const count = currentConv ? ((data.per_group || {})[currentConv] || 0) : 0;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  } catch (e) { /* 静默失败，下次事件/轮询再刷新 */ }
}

function handleJoinRequestPush(d) {
  // 静默：不做 toast（打扰），只刷红点徽章；弹窗开着且是当前群 → 直接刷新列表
  refreshJoinReqBadge();
  if (d && currentConv === d.group_openid && $('#joinRequestModal').classList.contains('show')) {
    loadJoinRequests();
  }
}
