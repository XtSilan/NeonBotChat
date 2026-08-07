// ── 查找聊天记录（设置→通用=全局；群聊设置=当前群）────
let msgSearchTimer = null;
let msgSearchConvId = '';  // '' = 全部群；有值 = 限定该群

function openMsgSearch(convId) {
  msgSearchConvId = convId || '';
  $('#msgSearchInput').value = '';
  $('#msgSearchInput').placeholder = msgSearchConvId ? '搜索当前群聊…' : '搜索全部群聊…';
  $('#msgSearchResults').innerHTML = `<div style="padding:20px;color:var(--text-dim);text-align:center;">输入关键词搜索${msgSearchConvId ? '当前群聊' : '全部群聊'}</div>`;
  $('#msgSearchModal').classList.add('show');
  $('#msgSearchInput').focus();
}

// 设置 → 通用：全局搜索
$('#btnOpenMsgSearch').addEventListener('click', () => openMsgSearch(''));
// 群聊设置：搜索当前群
$('#btnOpenConvSearch').addEventListener('click', () => {
  if (!currentConv) { showToast('⚠ 请先选择一个群聊'); return; }
  openMsgSearch(currentConv);
});
$('#btnCloseMsgSearch').addEventListener('click', () => $('#msgSearchModal').classList.remove('show'));
$('#msgSearchModal').addEventListener('click', (e) => {
  if (e.target === $('#msgSearchModal')) $('#msgSearchModal').classList.remove('show');
});

function renderMsgSearchResults(results, q) {
  const $box = $('#msgSearchResults');
  $box.innerHTML = results.length === 0
    ? `<div style="padding:20px;color:var(--text-dim);text-align:center;">未找到 "${escHtml(q)}" 相关消息</div>`
    : results.map(m => {
    // 头像：bot 自己发的用自己设置的头像（未设置则留空回退放大镜）；他人消息用发送者头像
    const avatarHtml = m.direction === 'outgoing'
      ? (getBotAvatar() ? `<img src="${escHtml(getBotAvatar())}" class="srch-avatar" onerror="this.classList.add('failed')" alt="">` : '')
      : (m.sender_avatar ? `<img src="${escHtml(m.sender_avatar)}" class="srch-avatar" onerror="this.classList.add('failed')" alt="">` : '');
    // 全局搜索（未限定群）时结果前标注群名
    const groupTag = msgSearchConvId
      ? ''
      : `<span style="color:var(--accent);font-size:0.75em;margin-right:4px;">${escHtml(m.conv_name || m.conversation_id)}</span>`;
    return `
      <div class="conv-item" data-conv-id="${m.conversation_id}" data-msg-id="${m.id}">
        <div class="avatar" style="background:#3b82f6;position:relative;">${avatarHtml}<img src="icons/search.svg" class="svg-icon" style="width:18px;height:18px;" alt=""></div>
        <div class="info">
          <div class="name">${groupTag}${fmtBotMarker(escHtml(m.sender_name || ''))} <span style="color:var(--text-dim);font-size:0.7em;">${escHtml((m.timestamp || '').slice(5, 16))}</span></div>
          <div class="preview">${escHtmlWithBr(m.content || '[图片/语音]')}</div>
        </div>
      </div>
    `;
    }).join('');
}

$('#msgSearchInput').addEventListener('input', () => {
  clearTimeout(msgSearchTimer);
  const q = $('#msgSearchInput').value.trim();
  if (!q) {
    $('#msgSearchResults').innerHTML = `<div style="padding:20px;color:var(--text-dim);text-align:center;">输入关键词搜索${msgSearchConvId ? '当前群聊' : '全部群聊'}</div>`;
    return;
  }
  msgSearchTimer = setTimeout(() => {
    API(`/api/search?q=${encodeURIComponent(q)}&conv_id=${encodeURIComponent(msgSearchConvId)}`).then(d => renderMsgSearchResults(d.results || [], q));
  }, 300);
});

// ── 首页统计看板（默认页）──────────────────────────
async function loadHomeStats() {
  const $box = $('#homeStats');
  if (!$box) return;
  const html = await renderStatsHtml();
  $box.innerHTML = html || '<div style="color:var(--text-dim);text-align:center;">暂无数据</div>';
}

// ── 群聊设置 → 导出聊天记录 ─────────────────────────
function exportChat(fmt) {
  if (!currentConv) { showToast('⚠ 请先选择一个群聊'); return; }
  window.open(`/api/export/${encodeURIComponent(currentConv)}?format=${fmt}`, '_blank');
}
$('#btnExportMd').addEventListener('click', () => exportChat('md'));
$('#btnExportJson').addEventListener('click', () => exportChat('json'));

// 点击结果：关闭两个弹窗并跳转定位
$('#msgSearchResults').addEventListener('click', (e) => {
  const item = e.target.closest('.conv-item');
  if (!item) return;
  const convId = item.dataset.convId;
  const msgId = parseInt(item.dataset.msgId) || 0;
  if (!convId) return;
  $('#msgSearchModal').classList.remove('show');
  hideRenameModal();
  selectConv(convId, msgId);
});

// MD 勾选框样式切换
function updateMdToggle() {
  const active = $('#mdCheckbox').checked;
  if (active) $('#mdToggle').classList.add('active');
  else $('#mdToggle').classList.remove('active');
  updateMdMenuStatus();
}
$('#mdCheckbox').addEventListener('change', updateMdToggle);

// ── 自定义消息 ────────────────────────────────────────
function openCustomMsgEditor() {
  $('#richMenu').style.display = 'none';
  $('#customMsgModal').classList.add('show');
  $('#customMsgJson').focus();
}
$('#btnCancelCustom').addEventListener('click', () => $('#customMsgModal').classList.remove('show'));
$('#customMsgModal').addEventListener('click', (e) => { if (e.target === $('#customMsgModal')) $('#customMsgModal').classList.remove('show'); });
$('#btnSendCustom').addEventListener('click', async () => {
  const jsonStr = $('#customMsgJson').value.trim();
  if (!jsonStr) return;
  if (!currentConv) { showToast('⚠ 请先选择一个群聊'); return; }
  let payload;
  try { payload = JSON.parse(jsonStr); } catch (e) { showToast('⚠ JSON 格式错误'); return; }
  payload.conv_id = currentConv;
  $('#customMsgModal').classList.remove('show');
  try {
    const r = await API('/api/send-raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r.error) { showToast('⚠ ' + r.error); }
    else { showToast('✅ 已发送'); }
  } catch (e) { showToast('⚠ 网络错误: ' + e.message); }
});

// ── 键盘消息 ──────────────────────────────────────────
function openKeyboardEditor() {
  $('#richMenu').style.display = 'none';
  $('#kbdModal').classList.add('show');
  $('#kbdContentInput').focus();
}

$('#btnCancelKbd').addEventListener('click', () => $('#kbdModal').classList.remove('show'));
$('#kbdModal').addEventListener('click', (e) => { if (e.target === $('#kbdModal')) $('#kbdModal').classList.remove('show'); });

$('#btnSendKbd').addEventListener('click', async () => {
  const msg = $('#kbdContentInput').value.trim();
  if (!msg) { showToast('⚠ 请输入消息内容'); return; }
  if (!currentConv) { showToast('⚠ 请先选择一个群聊'); return; }

  const kbdStr = $('#kbdJsonInput').value.trim();
  let kbdObj = null;
  if (kbdStr) {
    try { kbdObj = JSON.parse(kbdStr); } catch (e) { showToast('⚠ 键盘 JSON 格式错误'); return; }
  }

  $('#kbdModal').classList.remove('show');
  const body = { conv_id: currentConv, content: msg, msg_type: 2 };
  if (kbdObj) body.keyboard = kbdObj;

  try {
    const r = await API('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.error) { showToast('⚠ ' + r.error); }
    else { showToast('✅ 键盘消息已发送'); }
  } catch (e) { showToast('⚠ 网络错误: ' + e.message); }
});

// ── 卡片消息 ──────────────────────────────────────────
let cardType = 'tuwen';

function openCardEditor() {
  $('#richMenu').style.display = 'none';
  $('#cardModal').classList.add('show');
  switchCardType('tuwen');
  $('#cardTitle').focus();
}

function switchCardType(type) {
  cardType = type;
  $('#cardTypeTuwen').classList.toggle('active', type === 'tuwen');
  $('#cardTypeOther').classList.toggle('active', type === 'other');
  $('#cardFormTuwen').style.display = type === 'tuwen' ? '' : 'none';
  $('#cardFormOther').style.display = type === 'other' ? '' : 'none';
  if (type === 'tuwen') $('#cardTitle').focus();
  else $('#cardJsonInput').focus();
}

$('#btnCancelCard').addEventListener('click', () => $('#cardModal').classList.remove('show'));
$('#cardModal').addEventListener('click', (e) => { if (e.target === $('#cardModal')) $('#cardModal').classList.remove('show'); });

$('#btnSendCard').addEventListener('click', async () => {
  if (!currentConv) { showToast('⚠ 请先选择一个群聊'); return; }

  let jsonStr;
  if (cardType === 'tuwen') {
    const title = $('#cardTitle').value.trim();
    const desc = $('#cardDesc').value.trim();
    const picUrl = $('#cardPicUrl').value.trim();
    const jumpUrl = $('#cardJumpUrl').value.trim();
    if (!title) { showToast('⚠ 请填写卡片标题'); return; }
    jsonStr = JSON.stringify({
      type: 'tuwen',
      content: { title, description: desc, pic_url: picUrl, url: jumpUrl }
    });
  } else {
    jsonStr = $('#cardJsonInput').value.trim();
    if (!jsonStr) return;
    try { JSON.parse(jsonStr); } catch (e) { showToast('⚠ JSON 格式错误'); return; }
  }

  $('#cardModal').classList.remove('show');
  try {
    const r = await API('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conv_id: currentConv, content: jsonStr, msg_type: 8 }),
    });
    if (r.error) { showToast('⚠ ' + r.error); }
    else { showToast('✅ 卡片已发送'); }
  } catch (e) { showToast('⚠ 网络错误: ' + e.message); }
});

// ── 添加群聊弹窗 ────────────────────────────────────
const $addModal = $('#addConvModal');
const $newConvId = $('#newConvId');
const $newConvName = $('#newConvName');

function showAddModal() {
  $addModal.classList.add('show');
  $newConvId.value = '';
  $newConvName.value = '';
  $newConvId.focus();
}
function hideAddModal() {
  $addModal.classList.remove('show');
}

$('#btnAddConv').addEventListener('click', showAddModal);
$('#btnCancelAdd').addEventListener('click', hideAddModal);
$addModal.addEventListener('click', (e) => {
  if (e.target === $addModal) hideAddModal();
});

$('#btnOkAdd').addEventListener('click', async () => {
  const groupOpenid = $newConvId.value.trim();
  if (!groupOpenid) { alert('请输入群 OpenID'); return; }
  const name = $newConvName.value.trim();

  try {
    const result = await API('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_openid: groupOpenid, name }),
    });
    if (result.error) { alert('添加失败: ' + result.error); return; }

    hideAddModal();

    // 刷新会话列表
    const data = await API('/api/conversations');
    conversations = data.conversations || [];
    renderConvList();

    // 自动选中新添加的群
    selectConv(result.id);
  } catch (e) {
    alert('网络错误: ' + e.message);
  }
});

// Enter 快捷提交
$newConvId.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btnOkAdd').click();
});
$newConvName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btnOkAdd').click();
});

// ── 重命名弹窗 ────────────────────────────────────────
const $renameModal = $('#renameConvModal');
const $renameInput = $('#renameConvInput');

function showRenameModal() {
  if (!currentConv) return;
  const conv = conversations.find(c => c.id === currentConv);
  $renameInput.value = conv ? conv.name : '';
  $('#convOpenIdText').textContent = currentConv;
  $renameModal.classList.add('show');
  $renameInput.focus();
  $renameInput.select();
}

// 复制群 OpenID
$('#btnCopyConvId').addEventListener('click', async () => {
  const oid = $('#convOpenIdText').textContent || '';
  if (!oid) return;
  try {
    await navigator.clipboard.writeText(oid);
  } catch (e) {
    // 降级：选中文本 + execCommand
    const el = $('#convOpenIdText');
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('copy');
    sel.removeAllRanges();
  }
  showToast('✓ 已复制群 OpenID');
});
function hideRenameModal() {
  $renameModal.classList.remove('show');
}

$('#btnSettings').addEventListener('click', showRenameModal);
$('#mobileBackBtn').addEventListener('click', () => {
  document.getElementById('chatArea').classList.remove('mobile-open');
  document.querySelector('.sidebar').style.display = '';
});
$('#btnCancelRename').addEventListener('click', hideRenameModal);
$renameModal.addEventListener('click', (e) => {
  if (e.target === $renameModal) hideRenameModal();
});
$renameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btnOkRename').click();
  if (e.key === 'Escape') hideRenameModal();
});

$('#btnOkRename').addEventListener('click', async () => {
  const newName = $renameInput.value.trim();
  if (!newName || !currentConv) return;

  try {
    const result = await API(`/api/conversations/${currentConv}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    if (result.error) { alert('重命名失败: ' + result.error); return; }

    hideRenameModal();

    // 更新本地缓存 & UI
    const conv = conversations.find(c => c.id === currentConv);
    if (conv) conv.name = newName;
    $chatName.textContent = newName;
    renderConvList($searchInput.value);
  } catch (e) {
    alert('网络错误: ' + e.message);
  }
});

// ── 聊天背景设置（客户端独立）───────────────────────
function getBgSettings() {
  try { return JSON.parse(localStorage.getItem('neonbot_bg') || '{}'); }
  catch { return {}; }
}
function saveBgSettings(s) { localStorage.setItem('neonbot_bg', JSON.stringify(s)); }
function applyBg() {
  const s = getBgSettings();
  const $bg = $('#chatBgLayer');
  if (s.image) {
    $bg.style.backgroundImage = `url(${s.image})`;
    $bg.style.opacity = (s.opacity || 20) / 100;
    $('#chatHeader').classList.add('glass');
    $('#chatArea').classList.add('has-bg');
  } else {
    $bg.style.backgroundImage = '';
    $bg.style.opacity = '0';
    $('#chatHeader').classList.remove('glass');
    $('#chatArea').classList.remove('has-bg');
  }
}

$('#btnPickBg').addEventListener('click', () => $('#bgFileInput').click());
$('#bgFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const s = getBgSettings();
    s.image = reader.result;
    saveBgSettings(s);
    applyBg();
  };
  reader.readAsDataURL(file);
});
$('#btnClearBg').addEventListener('click', () => {
  const s = getBgSettings();
  delete s.image;
  saveBgSettings(s);
  applyBg();
  $('#bgFileInput').value = '';
});
$('#bgOpacity').addEventListener('input', function() {
  $('#bgOpacityVal').textContent = this.value + '%';
  const s = getBgSettings();
  s.opacity = parseInt(this.value);
  saveBgSettings(s);
  applyBg();
});
function syncBgUI() {
  const s = getBgSettings();
  $('#bgOpacity').value = s.opacity || 20;
  $('#bgOpacityVal').textContent = (s.opacity || 20) + '%';
}

$('#btnClearAllHistory').addEventListener('click', async () => {
  if (!(await showConfirm('确定要清空全部聊天记录吗？此操作不可撤销。'))) return;
  try {
    const r = await API('/api/messages', { method: 'DELETE' });
    if (r.error) { alert('清空失败: ' + r.error); }
  } catch (e) { alert('网络错误: ' + e.message); }
});

$('#btnClearHistory').addEventListener('click', async () => {
  if (!currentConv) return;
  if (!(await showConfirm('确定要清空该群聊的所有本地聊天记录吗？此操作不可撤销。'))) return;

  try {
    const result = await API(`/api/messages/${currentConv}`, { method: 'DELETE' });
    if (result.error) { alert('清空失败: ' + result.error); return; }

    hideRenameModal();

    // 清空当前界面
    $messages.innerHTML = '';
    lastMsgId = 0;

    // 更新会话列表
    const conv = conversations.find(c => c.id === currentConv);
    if (conv) { conv.last_message = ''; conv.unread_count = 0; }
    renderConvList($searchInput.value);
  } catch (e) {
    alert('网络错误: ' + e.message);
  }
});

// ── 设置弹窗 ─────────────────────────────────────────
const $settingsModal = $('#settingsModal');
$('#aboutBtn').addEventListener('click', () => {
  syncBgUI();
  $settingsModal.classList.add('show');
});
$settingsModal.addEventListener('click', (e) => {
  if (e.target === $settingsModal) $settingsModal.classList.remove('show');
});
// Tab 切换
$('#settingsNav').addEventListener('click', (e) => {
  const item = e.target.closest('.settings-nav-item');
  if (!item) return;
  document.querySelectorAll('.settings-nav-item').forEach(el => el.classList.remove('active'));
  item.classList.add('active');
  document.querySelectorAll('.settings-tab').forEach(el => el.style.display = 'none');
  const tab = document.getElementById('tab-' + item.dataset.tab);
  if (tab) {
    tab.style.display = '';
    if (item.dataset.tab === 'status') loadStatus();
    else if (item.dataset.tab === 'logs') loadLogs();
    else { stopStatusRefresh(); stopLogsRefresh(); }
  }
});

// ── 状态页面 ─────────────────────────────────────────
let statusTimer = null;

function stopStatusRefresh() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
}

async function loadStatus() {
  stopStatusRefresh();
  await refreshStatus();
  statusTimer = setInterval(refreshStatus, 1000);
}

async function refreshStatus() {
  const $sc = $('#statusContent');
  try {
    const info = await API('/api/system-info');
    $sc.innerHTML = `
      <div style="text-align:center;margin-bottom:12px;">
        <span style="font-size:1.1em;font-weight:700;"><img src="icons/bot.svg" class="svg-icon" style="width:20px;height:20px;" alt=""> NeonBotChat v26.8.3</span>
      </div>
      <div class="stat-card">
        <div class="stat-label"><img src="icons/system.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> 系统</div>
        <div class="stat-val">${escHtml(info.os)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label"><img src="icons/CPU.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> CPU</div>
        <div class="stat-val">${escHtml(info.cpu_model)}</div>
        <div class="stat-sub">使用率 ${info.cpu_percent}%</div>
        <div class="stat-bar"><div class="stat-bar-fill" style="width:${info.cpu_percent}%"></div></div>
      </div>
      <div class="stat-card">
        <div class="stat-label"><img src="icons/memory.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> 内存</div>
        <div class="stat-val">${info.mem_used} / ${info.mem_total} GB</div>
        <div class="stat-sub">${info.mem_percent}%</div>
        <div class="stat-bar"><div class="stat-bar-fill stat-bar-mem" style="width:${info.mem_percent}%"></div></div>
      </div>
      <div class="stat-card">
        <div class="stat-label"><img src="icons/timer.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> 系统已运行</div>
        <div class="stat-val">${info.sys_uptime}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label"><img src="icons/bot.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> Bot已运行</div>
        <div class="stat-val">${info.bot_uptime}</div>
      </div>`;
  } catch (e) {
    $sc.innerHTML = '<div style="color:var(--danger);">加载失败</div>';
  }
}

// ── 会话数据统计 ────────────────────────────────────
async function renderStatsHtml() {
  try {
    const st = await API('/api/stats');
    const recv = st.today.incoming || 0;
    const sent = st.today.outgoing || 0;
    const topRows = (st.top_convs || []).map(c => {
      const pct = st.total ? Math.round(c.count / st.total * 100) : 0;
      return `
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.82em;">${escHtml(c.name)}</span>
          <span style="font-size:0.78em;color:var(--text-dim);white-space:nowrap;">${c.count} 条</span>
          <div class="stat-bar" style="width:70px;flex-shrink:0;"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
        </div>`;
    }).join('');
    return `
      <div class="stat-card">
        <div class="stat-label"><img src="icons/query.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> 今日消息</div>
        <div class="stat-val">${recv + sent} 条</div>
        <div class="stat-sub">收到 ${recv} · 发出 ${sent} · 历史累计 ${st.total}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label"><img src="icons/chat.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> 活跃群 TOP5（近7天）</div>
        ${topRows || '<div class="stat-sub" style="margin-top:4px;">暂无数据</div>'}
      </div>`;
  } catch (e) {
    return '';
  }
}

// ── 日志页面 ─────────────────────────────────────────
let logsTimer = null;
let logsLastSeq = 0;

function stopLogsRefresh() {
  if (logsTimer) { clearInterval(logsTimer); logsTimer = null; }
}

async function loadLogs() {
  stopLogsRefresh();
  logsLastSeq = 0;
  const $lc = $('#logsContent');
  $lc.innerHTML = '加载中…';
  await refreshLogs();
  logsTimer = setInterval(refreshLogs, 2000);
}

async function refreshLogs() {
  const $lc = $('#logsContent');
  try {
    const r = await API('/api/logs?since=' + logsLastSeq);
    logsLastSeq = r.latest_seq;
    if ($lc.innerHTML === '加载中…') $lc.innerHTML = '';
    const rows = r.logs.map(l => {
      let color = 'inherit';
      let weight = '400';
      if (l.level === 'ERROR' || l.level === 'CRITICAL') { color = 'var(--danger)'; weight = '700'; }
      else if (l.level === 'WARNING') color = '#e67e22';
      else if (l.level === 'DEBUG') color = 'var(--text-dim)';
      return `<div><span style="color:var(--text-dim);">${escHtml(l.time)}</span> <span style="color:${color};font-weight:${weight};">[${escHtml(l.level)}]</span> ${escHtml(l.msg)}</div>`;
    }).join('');
    if (rows) {
      const wasAtBottom = $lc.scrollHeight - $lc.scrollTop - $lc.clientHeight < 30;
      $lc.insertAdjacentHTML('beforeend', rows);
      if (wasAtBottom) $lc.scrollTop = $lc.scrollHeight;
    }
  } catch (e) {
    $lc.innerHTML = '<div style="color:var(--danger);">加载日志失败</div>';
  }
}

// ── 桌面通知开关 ─────────────────────────────────────
const $chkNotify = $('#chkDesktopNotify');
if (localStorage.getItem('desktop_notify') === '1') $chkNotify.checked = true;
$chkNotify.addEventListener('change', () => {
  const on = $chkNotify.checked;
  if (!on) { localStorage.removeItem('desktop_notify'); return; }
  if (!('Notification' in window)) { showToast('⚠ 浏览器不支持桌面通知'); $chkNotify.checked = false; return; }
  if (Notification.permission === 'default') {
    Notification.requestPermission().then(p => {
      if (p === 'granted') { localStorage.setItem('desktop_notify', '1'); showToast('✓ 桌面通知已开启'); }
      else { $chkNotify.checked = false; showToast('⚠ 通知权限被拒绝'); }
    });
  } else if (Notification.permission === 'granted') {
    localStorage.setItem('desktop_notify', '1');
    showToast('✓ 桌面通知已开启');
  } else {
    $chkNotify.checked = false;
    showToast('⚠ 通知权限被拒绝，请在浏览器设置中允许');
  }
});

$('#favBtn').addEventListener('click', () => {
  renderFavList();
  $('#favModal').classList.add('show');
});
$('#btnCloseFav').addEventListener('click', () => $('#favModal').classList.remove('show'));
$('#favModal').addEventListener('click', (e) => { if (e.target === $('#favModal')) $('#favModal').classList.remove('show'); });
$('#btnClearFav').addEventListener('click', async () => {
  if (!(await showConfirm('确定清空全部收藏？'))) return;
  saveFavorites([]);
  renderFavList();
});

// ── 服务器设置读写 ───────────────────────────────────
let serverSettings = {};
let fileServerUrl = '';  // 图床公网 URL，用于判断直链

function isFileServerUrl(url) {
  if (!url || !fileServerUrl) return false;
  try { return url.startsWith(fileServerUrl); }
  catch { return false; }
}
async function loadServerSettings() {
  try {
    serverSettings = await API('/api/settings');
    fileServerUrl = serverSettings._file_server_url || '';
    if (serverSettings._developer_mode) {
      $('#richCustom').style.display = '';
    }
  }
  catch { serverSettings = {}; }
}
async function saveServerSetting(key, value) {
  serverSettings[key] = value;
  try { await API('/api/settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({[key]: value}) }); }
  catch {}
}

// ── Bot 简介 ─────────────────────────────────────────
function getBio() { return serverSettings.bio || ''; }
async function saveBio(text) { await saveServerSetting('bio', text); }
function renderBio() {
  const bio = getBio();
  $('#bioDisplay').textContent = bio || '点击添加简介…';
}

$('#bioDisplay').addEventListener('click', () => {
  $('#bioDisplay').style.display = 'none';
  $('#bioInput').style.display = '';
  $('#bioInput').value = getBio();
  $('#bioInput').focus();
});

$('#bioInput').addEventListener('blur', async () => {
  const text = $('#bioInput').value.trim();
  await saveBio(text);
  renderBio();
  $('#bioDisplay').style.display = '';
  $('#bioInput').style.display = 'none';
});

$('#bioInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#bioInput').blur();
});

// ── Bot 头像 ─────────────────────────────────────────
function getBotAvatar() { return serverSettings.avatar || ''; }
async function saveBotAvatar(dataUrl) { await saveServerSetting('avatar', dataUrl); }
function applyBotAvatar() {
  const av = getBotAvatar();
  if (av) {
    $('#botAvatarImg').src = av;
    $('#botAvatarImg').style.display = '';
    $('#botAvatarPlaceholder').style.display = 'none';
  } else {
    $('#botAvatarImg').style.display = 'none';
    $('#botAvatarPlaceholder').style.display = '';
  }
}

$('#botAvatarUpload').addEventListener('click', () => $('#botAvatarFile').click());
$('#botAvatarFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    await saveBotAvatar(reader.result);
    applyBotAvatar();
  };
  reader.readAsDataURL(file);
});

// 更新账号页的 Bot 名称
function updateAccountBotName() {
  const el = $('#accountBotName');
  // 去掉末尾的 🤖，账号页不需要
  if (el) el.textContent = (botDisplayName || 'Bot').replace(/ 🤖$/, '');
}

// ── 自定义确认弹窗 ────────────────────────────────────
function showConfirm(msg, iconName = 'warning', danger = true, showCancel = true) {
  return new Promise(resolve => {
    $('#confirmMsg').textContent = msg;
    $('#confirmIcon').innerHTML = '<img src="icons/' + iconName + '.svg" class="svg-icon" style="width:36px;height:36px;" alt="">';
    const okBtn = $('#confirmOk');
    okBtn.className = danger ? 'glass-btn danger' : 'glass-btn active';
    $('#confirmCancel').style.display = showCancel ? '' : 'none';
    $('#confirmDialog').classList.add('show');
    const ok = () => { hideConfirm(); resolve(true); };
    const cancel = () => { hideConfirm(); resolve(false); };
    $('#confirmOk').onclick = ok;
    $('#confirmCancel').onclick = cancel;
    $('#confirmDialog').onclick = (e) => { if (e.target === $('#confirmDialog')) cancel(); };
  });
}
function hideConfirm() { $('#confirmDialog').classList.remove('show'); }

// ── 退出登录 ────────────────────────────────────────
$('#btnLogout').addEventListener('click', async () => {
  if (!(await showConfirm('确定要退出登录吗？'))) return;
  await API('/api/logout', { method: 'POST' });
  window.location.reload();
});

// ── 深浅模式 ────────────────────────────────────────
let systemDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);

function setTheme(mode) {
  const dark = mode === 'auto' ? systemDark : mode === 'dark';
  document.body.classList.toggle('light', !dark);
  $('#themeDark').classList.toggle('active', mode === 'dark');
  $('#themeLight').classList.toggle('active', mode === 'light');
  $('#themeAuto').classList.toggle('active', mode === 'auto');
  localStorage.setItem('neonbot_theme', mode);
}

// 系统主题变化时，「自动」模式实时跟随
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    systemDark = e.matches;
    if (localStorage.getItem('neonbot_theme') === 'auto') setTheme('auto');
  });
}

// ── 启动 ─────────────────────────────────────────────
// init() 定义在 core.js，依赖本文件（settings.js）的函数，故在所有文件加载完后执行
init();

