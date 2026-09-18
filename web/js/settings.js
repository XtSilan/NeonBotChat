// ── 查找聊天记录（设置→通用=全局；群聊设置=当前群）────
let msgSearchTimer = null;
let msgSearchConvId = '';  // '' = 全部群；有值 = 限定该群

function openMsgSearch(convId) {
  msgSearchConvId = convId || '';
  $('#msgSearchInput').value = '';
  $('#msgSearchInput').placeholder = msgSearchConvId ? '搜索当前对话…' : '搜索全部群聊…';
  $('#msgSearchResults').innerHTML = `<div style="padding:20px;color:var(--text-dim);text-align:center;">输入关键词搜索${msgSearchConvId ? '当前对话' : '全部群聊'}</div>`;
  $('#msgSearchModal').classList.add('show');
  $('#msgSearchInput').focus();
}

// 设置 → 通用：全局搜索
$('#btnOpenMsgSearch').addEventListener('click', () => openMsgSearch(''));
// 群聊设置：搜索当前群
$('#btnOpenConvSearch').addEventListener('click', () => {
  if (!currentConv) { showToast('⚠ 请先选择一个会话'); return; }
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
    $('#msgSearchResults').innerHTML = `<div style="padding:20px;color:var(--text-dim);text-align:center;">输入关键词搜索${msgSearchConvId ? '当前对话' : '全部群聊'}</div>`;
    return;
  }
  msgSearchTimer = setTimeout(() => {
    API(`/api/search?q=${encodeURIComponent(q)}&conv_id=${encodeURIComponent(msgSearchConvId)}`).then(d => renderMsgSearchResults(d.results || [], q));
  }, 300);
});

// ── 周报导出（看板右下角浮动按钮）─────────────────
$('#btnExportReport').addEventListener('click', exportWeeklyReport);

let statsAccountId = localStorage.getItem('neonbot_stats_account') || '';

function statsApiUrl() {
  return statsAccountId ? `/api/stats?account_id=${encodeURIComponent(statsAccountId)}` : '/api/stats';
}

// ── 周报导出（统计看板数据 → Markdown）─────────────
async function exportWeeklyReport() {
  try {
    const st = await API(statsApiUrl());
    const recv = st.today.incoming || 0;
    const sent = st.today.outgoing || 0;
    const media = st.media || {};
    const lines = [
      '# 📊 NeonBotChat 本周简报',
      '',
      `> 生成时间：${new Date().toLocaleString('zh-CN')}`,
      '',
      '## 消息概况',
      `- 今日消息：${recv + sent} 条（收到 ${recv} / 发出 ${sent}）`,
      `- 历史累计：${st.total} 条`,
      `- 近7天引用回复：${st.quoted || 0} 条`,
      '',
      '## 每日趋势（近7天）',
      ...(st.trend || []).map(t => `- ${t.d}：${t.count} 条`),
      '',
      '## 活跃群 TOP5',
      ...(st.top_convs || []).map((c, i) => `${i + 1}. ${c.name}：${c.count} 条`),
      '',
      '## 媒体消息分布',
      `- 图片 ${media.image || 0} · 视频 ${media.video || 0} · 语音 ${media.voice || 0} · 文件 ${media.file || 0}`,
      '',
      '## 会话参与度',
      `- 近7天活跃会话 ${(st.convs && st.convs.active) || 0} / 总会话 ${(st.convs && st.convs.total) || 0}`,
      '',
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `NeonBot周报_${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    showToast('✓ 周报已导出');
  } catch (e) {
    showToast('⚠ 周报生成失败');
  }
}

// ── 首页统计看板（默认页）──────────────────────────
async function loadHomeStats() {
  const $box = $('#homeStats');
  if (!$box) return;
  try {
    const accountData = await API('/api/accounts');
    const accounts = accountData.accounts || [];
    if (statsAccountId && !accounts.some(account => account.appid === statsAccountId)) {
      statsAccountId = '';
      localStorage.removeItem('neonbot_stats_account');
    }
    const options = accounts.map(account => `
      <option value="${escHtml(account.appid)}" ${statsAccountId === account.appid ? 'selected' : ''}>
        ${escHtml(account.bot_name || account.appid)}
      </option>`).join('');
    const html = await renderStatsHtml(statsAccountId);
    $box.innerHTML = `
      <div class="stats-toolbar">
        <div>
          <div class="stats-toolbar-title">数据概览</div>
          <div class="stats-toolbar-meta">${accounts.length} 个账号</div>
        </div>
        <label class="stats-account-filter" for="statsAccountSelect">
          <span>统计范围</span>
          <select id="statsAccountSelect">
            <option value="" ${statsAccountId ? '' : 'selected'}>全部账号</option>
            ${options}
          </select>
        </label>
      </div>
      ${html || '<div class="stats-empty">暂无数据</div>'}`;
    $('#statsAccountSelect').addEventListener('change', event => {
      statsAccountId = event.target.value;
      if (statsAccountId) localStorage.setItem('neonbot_stats_account', statsAccountId);
      else localStorage.removeItem('neonbot_stats_account');
      loadHomeStats();
    });
  } catch (error) {
    $box.innerHTML = '<div class="stats-empty">统计数据加载失败</div>';
  }
}

// 卡片鼠标聚焦光效：径向高光跟随指针
$('#homeStats').addEventListener('mousemove', (e) => {
  const card = e.target.closest('.stat-card');
  if (!card) return;
  let spot = card.querySelector('.stat-spotlight');
  if (!spot) {
    spot = document.createElement('div');
    spot.className = 'stat-spotlight';
    card.appendChild(spot);
  }
  const r = card.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  // 深色模式白色光晕，浅色模式黑色光晕
  const isLight = document.body.classList.contains('light');
  spot.style.background = isLight
    ? `radial-gradient(180px circle at ${x}px ${y}px, rgba(0,0,0,0.06), transparent 65%)`
    : `radial-gradient(180px circle at ${x}px ${y}px, rgba(255,255,255,0.18), transparent 65%)`;
});

// ── 群聊设置 → 导出聊天记录 ─────────────────────────
function exportChat(fmt) {
  if (!currentConv) { showToast('⚠ 请先选择一个会话'); return; }
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
  if (!currentConv) { showToast('⚠ 请先选择一个会话'); return; }
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
  if (!currentConv) { showToast('⚠ 请先选择一个会话'); return; }

  const kbdStr = $('#kbdJsonInput').value.trim();
  let kbdObj = null;
  if (kbdStr) {
    try { kbdObj = JSON.parse(kbdStr); } catch (e) { showToast('⚠ 键盘 JSON 格式错误'); return; }
  }

  // 无主动消息权限的群：发送前弹确认（取消则不关弹窗）
  if (!(await ensureProactiveAllowed())) return;

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
  if (!currentConv) { showToast('⚠ 请先选择一个会话'); return; }

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

  // 无主动消息权限的群：发送前弹确认（取消则不关弹窗）
  if (!(await ensureProactiveAllowed())) return;

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

// ── 添加好友或群聊弹窗 ────────────────────────────────
const $addModal = $('#addConvModal');
const $newConvId = $('#newConvId');
const $newConvName = $('#newConvName');
let addConvType = 'group';  // group | direct

function setAddConvType(t) {
  addConvType = t;
  $('#btnAddTypeGroup').classList.toggle('active', t === 'group');
  $('#btnAddTypeDirect').classList.toggle('active', t === 'direct');
  $('#newConvIdLabel').textContent = t === 'direct' ? '用户 OpenID' : '群 OpenID';
  $('#newConvId').placeholder = t === 'direct' ? '粘贴用户 openid…' : '粘贴群 group_openid…';
  $('#newConvName').placeholder = t === 'direct' ? '例如：小明' : '例如：摸鱼群';
}

function showAddModal() {
  $addModal.classList.add('show');
  $newConvId.value = '';
  $newConvName.value = '';
  setAddConvType('group');
  $newConvId.focus();
}
function hideAddModal() {
  $addModal.classList.remove('show');
}

$('#btnAddConv').addEventListener('click', showAddModal);
$('#btnAddTypeGroup').addEventListener('click', () => setAddConvType('group'));
$('#btnAddTypeDirect').addEventListener('click', () => setAddConvType('direct'));
$('#btnCancelAdd').addEventListener('click', hideAddModal);
$addModal.addEventListener('click', (e) => {
  if (e.target === $addModal) hideAddModal();
});

$('#btnOkAdd').addEventListener('click', async () => {
  const openid = $newConvId.value.trim();
  if (!openid) { alert(addConvType === 'direct' ? '请输入用户 OpenID' : '请输入群 OpenID'); return; }
  const name = $newConvName.value.trim();

  try {
    const result = await API('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conv_type: addConvType, openid, name }),
    });
    if (result.error) { alert('添加失败: ' + result.error); return; }

    hideAddModal();

    // 刷新会话列表
    const data = await API('/api/conversations');
    conversations = data.conversations || [];
    renderConvList();

    // 自动选中新添加的会话
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
  // 预填：已有备注用备注，否则用当前显示名（官方群名）作为修改起点
  $renameInput.value = conv ? (conv.user_note || conv.display_name || conv.name || '') : '';
  $('#convOpenIdText').textContent = currentConv;
  // 私聊文案「个人」化
  const isDirect = conv && conv.type === 'direct';
  $renameModal.querySelector('h3').innerHTML = `<img src="icons/settings.svg" class="svg-icon" style="width:18px;height:18px;" alt=""> ${isDirect ? '个人设置' : '群聊设置'}`;
  $('#convOpenIdLabel').textContent = isDirect ? '用户 OpenID' : '群 OpenID';
  // 个人头像由系统自动获取（PatchUserInfo）：上传框去掉，只保留头像展示
  $('#convAvatarUpload').classList.toggle('avatar-static', isDirect);
  $('#convAvatarUpload').title = isDirect ? '' : '点击上传群头像';
  $('#convAvatarHint').style.display = isDirect ? 'none' : '';
  // 群头像预览 + 群名
  $('#convAvatarName').textContent = conv ? (conv.display_name || conv.name || currentConv) : currentConv;
  const av = conv && conv.avatar_url ? conv.avatar_url : '';
  if (av) {
    $('#convAvatarImg').src = av;
    $('#convAvatarImg').style.display = '';
    $('#convAvatarPlaceholder').style.display = 'none';
  } else {
    $('#convAvatarImg').style.display = 'none';
    $('#convAvatarPlaceholder').style.display = '';
    $('#convAvatarPlaceholder').textContent = ((conv && (conv.display_name || conv.name)) || currentConv || '?')[0];
  }
  $renameModal.classList.add('show');
  $renameInput.focus();
  $renameInput.select();
}

// ── 群头像上传（个人头像系统自动获取，上传框已去掉） ──
$('#convAvatarUpload').addEventListener('click', () => {
  const conv = conversations.find(c => c.id === currentConv);
  if (conv && conv.type === 'direct') return;  // 静态展示，无上传交互
  $('#convAvatarFile').click();
});
$('#convAvatarFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const conv = conversations.find(c => c.id === currentConv);
  if (!file || !currentConv || (conv && conv.type === 'direct')) return;
  if (file.size > 2 * 1024 * 1024) { showToast('⚠ 图片不能超过 2MB'); return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const r = await API(`/api/conversations/${encodeURIComponent(currentConv)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar: reader.result }),
      });
      if (r && r.error) { showToast('⚠ ' + r.error); return; }
      // 更新本地会话数据
      const conv = conversations.find(c => c.id === currentConv);
      if (conv) conv.avatar_url = reader.result;
      if (searchResults) {
        const sc = searchResults.find(c => c.id === currentConv);
        if (sc) sc.avatar_url = reader.result;
      }
      // 更新预览和列表
      $('#convAvatarImg').src = reader.result;
      $('#convAvatarImg').style.display = '';
      $('#convAvatarPlaceholder').style.display = 'none';
      renderConvList($searchInput.value);
      applyChatHeaderAvatar();
      showToast('✓ 群头像已更新');
    } catch (err) {
      showToast('⚠ 网络错误');
    }
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

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
  document.querySelectorAll('.sidebar, .side-rail').forEach(el => el.style.display = '');
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
  if (!currentConv) return;  // 备注可为空 = 清除备注

  try {
    const result = await API(`/api/conversations/${currentConv}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    if (result.error) { alert('重命名失败: ' + result.error); return; }

    hideRenameModal();

    // 更新本地缓存 & UI（user_note 优先于官方群名显示；清空后回落到官方群名）
    const conv = conversations.find(c => c.id === currentConv);
    if (conv) {
      conv.name = newName;
      conv.user_note = newName;
      conv.display_name = newName || conv.official_name || conv.name || conv.id;
    }
    if (searchResults) {
      const sc = searchResults.find(c => c.id === currentConv);
      if (sc) { sc.name = newName; sc.user_note = newName; sc.display_name = newName || sc.official_name || sc.name || sc.id; }
    }
    $('#chatNameInner').textContent = fmtConvTitle(conv || { id: currentConv, name: newName });
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

// ── 设置 / 收藏：桌面端弹窗 + 移动端真实页面，内容共用一份（住在 #pageSettings/#pageFav 里） ──
const $settingsModal = $('#settingsModal');
const $pageSettings = $('#pageSettings');
const $pageFav = $('#pageFav');
function openSettings() {
  closeMobilePages();  // 收藏页若开着先关掉（两个页面互斥）
  if (window.innerWidth <= 768) {
    // 若内容此前留在桌面弹窗壳里（改窗口尺寸场景），先移回页面容器
    if ($pageSettings.parentElement.classList.contains('modal-box')) document.body.appendChild($pageSettings);
    hideMobilePageBack();  // 隐藏底下的消息/主页，毛玻璃糊在背景上
    $pageSettings.classList.add('open');
  } else {
    $('#settingsModalBox').appendChild($pageSettings);
    $settingsModal.classList.add('show');
    // 桌面弹窗语义：每次打开都回到「通用」标签页、滚动置顶（移动端页面保留上次位置；
    // 头像/logo 等入口在 openSettings 之后再点目标标签页，跳转不受影响）
    document.querySelector('.settings-nav-item[data-tab="general"]').click();
    $('.settings-content').scrollTop = 0;
  }
  syncMobileTab();  // 移动端底栏高亮切到「设置」
}
function closeSettings() {
  $settingsModal.classList.remove('show');
  $pageSettings.classList.remove('open');
  syncMobileTab();
}
function openFav() {
  closeMobilePages();  // 设置页若开着先关掉（两个页面互斥）
  if (window.innerWidth <= 768) {
    if ($pageFav.parentElement.classList.contains('modal-box')) document.body.appendChild($pageFav);
    hideMobilePageBack();  // 隐藏底下的消息/主页，毛玻璃糊在背景上
    $pageFav.classList.add('open');
  } else {
    $('#favModalBox').appendChild($pageFav);
    $('#favModal').classList.add('show');
  }
  renderFavList();
  syncMobileTab();  // 移动端底栏高亮切到「收藏」
}
function closeFav() {
  $('#favModal').classList.remove('show');
  $pageFav.classList.remove('open');
  syncMobileTab();
}
$('#aboutBtn').addEventListener('click', () => {
  syncBgUI();
  openSettings();
});
$settingsModal.addEventListener('click', (e) => {
  if (e.target === $settingsModal) {
    closeSettings();
  }
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

// 移动端：收起/展开导航文字（只留图标，右侧内容区更宽）
$('#btnNavFold').addEventListener('click', () => {
  const nav = $('#settingsNav');
  const folded = nav.classList.toggle('folded');
  const btn = $('#btnNavFold');
  btn.classList.toggle('active', folded);
  btn.title = folded ? '展开导航文字' : '收起导航文字';
  btn.querySelector('img').src = 'icons/' + (folded ? 'right_arrow' : 'left_arrow') + '.svg';
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
      <div style="text-align:center;margin-bottom:12px;position:relative;">
        <span style="font-size:1.1em;font-weight:700;"><img src="icons/bot.svg" class="svg-icon" style="width:20px;height:20px;" alt=""> NeonBotChat v26.8.7</span>
        <button class="glass-btn danger" onclick="restartServer()" style="position:absolute;right:0;top:0;padding:3px 10px;font-size:0.75em;color:var(--danger);"><img src="icons/restart_red.svg" style="width:12px;height:12px;filter:none;" alt=""> 重启服务</button>
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

// ── 重启服务（后端重启后自动刷新页面）───────────────
async function restartServer() {
  if (!(await showConfirm('确定重启服务吗？重启后页面将自动刷新', 'warning'))) return;
  try {
    await API('/api/restart', { method: 'POST' });
  } catch (e) { /* 后端可能立即断开，忽略 */ }
  showToast('⚠ 服务重启中…');
  let tries = 0;
  const timer = setInterval(async () => {
    tries++;
    if (tries > 40) { clearInterval(timer); showToast('⚠ 重启超时，请手动刷新'); return; }
    try {
      const r = await fetch('/api/system-info');
      if (r.ok) { clearInterval(timer); location.reload(); }
    } catch (e) { /* 服务未就绪，继续等待 */ }
  }, 1000);
}

// ── 会话数据统计 ────────────────────────────────────
function fmtTrendLabel(d) {
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (d === ymd) return '今天';
  const yest = new Date(Date.now() - 86400000);
  const yestStr = `${yest.getFullYear()}-${String(yest.getMonth() + 1).padStart(2, '0')}-${String(yest.getDate()).padStart(2, '0')}`;
  if (d === yestStr) return '昨天';
  const [, m, day] = d.split('-');
  return `${parseInt(m)}/${parseInt(day)}`;
}

async function renderStatsHtml(accountId = statsAccountId) {
  try {
    const url = accountId ? `/api/stats?account_id=${encodeURIComponent(accountId)}` : '/api/stats';
    const st = await API(url);
    const recv = st.today.incoming || 0;
    const sent = st.today.outgoing || 0;
    // 近 7 天趋势柱状图
    const trend = st.trend || [];
    const trendMax = Math.max(1, ...trend.map(t => t.count));
    const trendHtml = trend.map(t => {
      const h = Math.round(t.count / trendMax * 52);
      return `
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:3px;">
          <div style="font-size:0.65em;color:var(--text-dim);">${t.count}</div>
          <div style="width:70%;background:var(--accent);border-radius:2px;height:${h}px;opacity:${t.count ? 0.85 : 0.15};"></div>
          <div style="font-size:0.62em;color:var(--text-dim);white-space:nowrap;">${fmtTrendLabel(t.d)}</div>
        </div>`;
    }).join('') || '<div class="stat-sub">暂无数据</div>';
    // 24 小时活跃分布
    const hourly = st.hourly || {};
    const hMax = Math.max(1, ...Object.values(hourly));
    const hourHtml = Array.from({ length: 24 }, (_, h) => {
      const cnt = hourly[h] || 0;
      const barH = Math.max(2, Math.round(cnt / hMax * 42));
      return `
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;height:48px;" title="${h}时: ${cnt}条">
          <div style="background:${cnt ? 'var(--accent)' : 'rgba(255,255,255,0.07)'};border-radius:1px;height:${barH}px;opacity:${cnt ? 0.8 : 1};"></div>
        </div>`;
    }).join('');
    // 星期×小时热力图（dow: 周日=0 … 周六=6；sqrt 分级让低值也有区分度）
    const heat = st.heatmap || {};
    const hmMax = Math.max(1, ...Object.values(heat).flatMap(m => Object.values(m)));
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const heatmapHtml = days.map((label, dow) => `
      <div style="display:flex;align-items:center;gap:3px;">
        <span style="width:28px;flex-shrink:0;font-size:0.62em;color:var(--text-dim);">${label}</span>
        ${Array.from({ length: 24 }, (_, hr) => {
          const cnt = (heat[dow] || {})[hr] || 0;
          const op = cnt ? (0.15 + 0.85 * Math.sqrt(cnt / hmMax)).toFixed(2) : 1;
          return `<div style="flex:1;height:14px;border-radius:2px;background:${cnt ? 'var(--accent)' : 'rgba(150,150,155,0.18)'};opacity:${op};" title="${label} ${String(hr).padStart(2, '0')}:00 — ${cnt}条"></div>`;
        }).join('')}
      </div>`).join('');
    // 媒体消息分布
    const media = st.media || {};
    const mediaTotal = Math.max(1, (media.image || 0) + (media.video || 0) + (media.voice || 0) + (media.file || 0));
    const mediaRows = [
      ['image', 'icons/image.svg', '图片'],
      ['video', 'icons/video.svg', '视频'],
      ['voice', 'icons/audio.svg', '语音'],
      ['file', 'icons/documents.svg', '文件'],
    ].map(([k, icon, name]) => {
      const cnt = media[k] || 0;
      const pct = Math.round(cnt / mediaTotal * 100);
      return `
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
          <img src="${icon}" class="svg-icon" style="width:14px;height:14px;" alt="">
          <span style="width:30px;font-size:0.8em;">${name}</span>
          <div class="stat-bar" style="flex:1;margin-top:0;"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
          <span style="font-size:0.75em;color:var(--text-dim);width:44px;text-align:right;">${cnt}条</span>
        </div>`;
    }).join('');
    // 活跃群 TOP5
    const topRows = (st.top_convs || []).map(c => {
      const pct = st.total ? Math.round(c.count / st.total * 100) : 0;
      return `
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.82em;">${escHtml(c.name)}</span>
          <span style="font-size:0.78em;color:var(--text-dim);white-space:nowrap;">${c.count} 条</span>
          <div class="stat-bar" style="width:70px;flex-shrink:0;"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
        </div>`;
    }).join('');
    // 发言达人 TOP5（近7天，按成员昵称聚合）
    const senders = st.top_senders || [];
    const sMax = Math.max(1, ...senders.map(s => s.count));
    const senderRows = senders.map(s => {
      const pct = Math.round(s.count / sMax * 100);
      const initial = [...(s.name || '')][0] || '?';
      const avatarHtml = s.avatar
        ? `<img src="${escHtml(s.avatar)}" style="width:24px;height:24px;border-radius:50%;object-fit:cover;flex-shrink:0;" onerror="this.style.display='none'">`
        : `<div style="width:24px;height:24px;border-radius:50%;background:var(--accent);color:#fff;font-size:0.65em;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${escHtml(initial)}</div>`;
      return `
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
          ${avatarHtml}
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.82em;">${escHtml(s.name)}</span>
          <span style="font-size:0.78em;color:var(--text-dim);white-space:nowrap;">${s.count} 条</span>
          <div class="stat-bar" style="width:70px;flex-shrink:0;"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
        </div>`;
    }).join('');
    // 会话参与度
    const convs = st.convs || {};
    const actPct = convs.total ? Math.round((convs.active || 0) / convs.total * 100) : 0;
    return `
      <div class="stat-card">
        <div class="stat-label"><img src="icons/chat.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> 今日消息</div>
        <div class="stat-val">${recv + sent} 条</div>
        <div class="stat-sub">收到 ${recv} · 发出 ${sent} · 历史累计 ${st.total}</div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:0.78em;color:var(--text-dim);">
          <img src="icons/quote.svg" class="svg-icon" style="width:13px;height:13px;" alt=""> 近7天引用回复 ${st.quoted || 0} 条
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label"><img src="icons/chart.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> 近7天消息趋势</div>
        <div style="display:flex;align-items:flex-end;gap:4px;margin-top:8px;">${trendHtml}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label"><img src="icons/clock.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> 24小时活跃分布（近7天）</div>
        <div style="display:flex;align-items:flex-end;gap:2px;margin-top:8px;">${hourHtml}</div>
        <div style="display:flex;justify-content:space-between;font-size:0.6em;color:var(--text-dim);margin-top:3px;">
          <span>0时</span><span>6时</span><span>12时</span><span>18时</span><span>23时</span>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label"><img src="icons/clock.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> 活跃时段热力图（近7天）</div>
        <div style="display:flex;flex-direction:column;gap:3px;margin-top:8px;">${heatmapHtml}</div>
        <div style="display:flex;justify-content:space-between;font-size:0.6em;color:var(--text-dim);margin-top:3px;">
          <span>0时</span><span>6时</span><span>12时</span><span>18时</span><span>23时</span>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label"><img src="icons/media.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> 媒体消息分布（近7天）</div>
        ${mediaRows}
      </div>
      <div class="stat-card">
        <div class="stat-label"><img src="icons/rank.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> 活跃群 TOP5（近7天）</div>
        ${topRows || '<div class="stat-sub" style="margin-top:4px;">暂无数据</div>'}
      </div>
      <div class="stat-card">
        <div class="stat-label"><img src="icons/rank.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> 发言达人 TOP5（近7天）</div>
        ${senderRows || '<div class="stat-sub" style="margin-top:4px;">暂无数据</div>'}
      </div>
      <div class="stat-card">
        <div class="stat-label"><img src="icons/groups.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> 会话参与度</div>
        <div class="stat-val">${convs.active || 0} / ${convs.total || 0}</div>
        <div class="stat-sub">近7天活跃会话 / 总会话数</div>
        <div class="stat-bar"><div class="stat-bar-fill" style="width:${actPct}%"></div></div>
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

// ── 链接卡片开关（账号与安全）────────────────────────
const $chkLinkCards = $('#chkLinkCards');
if (localStorage.getItem('link_cards') === '0') $chkLinkCards.checked = false;
$chkLinkCards.addEventListener('change', () => {
  localStorage.setItem('link_cards', $chkLinkCards.checked ? '1' : '0');
});

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

$('#favBtn').addEventListener('click', () => { openFav(); });
$('#btnCloseFav').addEventListener('click', () => { closeFav(); });
$('#favModal').addEventListener('click', (e) => { if (e.target === $('#favModal')) { closeFav(); } });
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
    await refreshBotAvatar();  // 头像直接读官方接口（GET /users/@me）
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
  // 移动端顶栏：昵称下方显示个性签名，未设置则隐藏
  const mb = $('#mobileBio');
  if (mb) { mb.textContent = bio; mb.style.display = bio ? '' : 'none'; }
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
  // 侧侧栏 Bot 头像（有头像显示头像，无则 query.svg，失败回退 query.svg）
  const rail = $('#railBotAvatar');
  if (rail) {
    rail.innerHTML = av
      ? `<img src="${escHtml(av)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" onerror="this.outerHTML='<img src=&quot;icons/query.svg&quot; class=&quot;svg-icon&quot; style=&quot;width:22px;height:22px&quot; alt=&quot;&quot;>'">`
      : `<img src="icons/query.svg" class="svg-icon" style="width:22px;height:22px;" alt="">`;
  }
  // 移动端顶栏头像：真实头像不带反色滤镜（svg-icon 会 invert），回退时恢复 query.svg
  const mav = $('#mobileBotAvatarImg');
  if (mav) {
    if (av) {
      mav.classList.remove('svg-icon');
      mav.src = av;
      mav.onerror = () => { mav.onerror = null; mav.classList.add('svg-icon'); mav.src = 'icons/query.svg'; };
    } else {
      mav.src = 'icons/query.svg';
      mav.classList.add('svg-icon');
    }
  }
}

// 头像来自官方接口（GET /users/@me），不提供手动上传
// 页面加载时拉取并覆盖 serverSettings.avatar
async function refreshBotAvatar() {
  try {
    const r = await API('/api/bot-info');
    if (r && r.avatar) {
      serverSettings.avatar = r.avatar;
      applyBotAvatar();
    }
  } catch {}
}

// 点击侧栏头像 → 打开设置并跳到「机器人信息」（头像只读，不提供上传）
$('#railBotAvatar').addEventListener('click', () => {
  openSettings();
  document.querySelector('.settings-nav-item[data-tab="account"]').click();
});

// 移动端顶栏头像：与侧栏头像同行为 → 设置-账号与安全页
$('#mobileBotAvatar').addEventListener('click', () => {
  openSettings();
  document.querySelector('.settings-nav-item[data-tab="account"]').click();
});

// 点击 Bot logo / 「BotChat」 → 打开设置并跳到「关于与帮助」（桌面侧栏 + 移动端顶栏共用）
$('#railLogo').addEventListener('click', () => {
  openSettings();
  document.querySelector('.settings-nav-item[data-tab="about"]').click();
});
$('#mobileLogo').addEventListener('click', () => {
  openSettings();
  document.querySelector('.settings-nav-item[data-tab="about"]').click();
});

// 更新账号页的 Bot 名称
function updateAccountBotName() {
  const el = $('#accountBotName');
  // 去掉末尾的 🤖，账号页不需要
  if (el) el.textContent = (botDisplayName || 'Bot').replace(/ 🤖$/, '');
  // 移动端顶栏昵称
  const mb = $('#mobileBotName');
  if (mb) mb.textContent = botDisplayName || 'Bot';
}

// ── 自定义确认弹窗 ────────────────────────────────────
function showConfirm(msg, iconName = 'warning', danger = true, showCancel = true, thirdText = '', previewUrl = '', previewType = '', inputPlaceholder = '') {
  return new Promise(resolve => {
    $('#confirmMsg').textContent = msg;
    $('#confirmIcon').innerHTML = '<img src="icons/' + iconName + '.svg" class="svg-icon" style="width:36px;height:36px;" alt="">';
    // 可选输入框（如拒绝原因）：传 inputPlaceholder 则显示；返回 {action, reason}
    const input = $('#confirmInput');
    const hasInput = !!inputPlaceholder;
    if (hasInput) {
      input.value = '';
      input.placeholder = inputPlaceholder;
      input.style.display = '';
      input.focus();
    } else {
      input.style.display = 'none';
    }
    // 图片/视频预览（粘贴发送用）
    const $pv = $('#confirmPreview');
    const $pvi = $('#confirmPreviewImg');
    const $pvv = $('#confirmPreviewVideo');
    if (previewUrl && (previewType === 'image' || previewType === 'video')) {
      $pv.style.display = '';
      if (previewType === 'image') {
        $pvi.src = previewUrl; $pvi.style.display = '';
        $pvv.style.display = 'none'; $pvv.removeAttribute('src');
      } else {
        $pvv.src = previewUrl; $pvv.style.display = '';
        $pvi.style.display = 'none'; $pvi.removeAttribute('src');
      }
    } else {
      $pv.style.display = 'none';
      $pvi.removeAttribute('src'); $pvv.removeAttribute('src');
    }
    const okBtn = $('#confirmOk');
    okBtn.className = danger ? 'glass-btn danger' : 'glass-btn active';
    $('#confirmCancel').style.display = showCancel ? '' : 'none';
    // 可选第三按钮：点击 resolve 'third'
    const thirdBtn = $('#confirmThird');
    if (thirdText) {
      thirdBtn.textContent = thirdText;
      thirdBtn.className = 'glass-btn';
      thirdBtn.style.display = '';
    } else {
      thirdBtn.style.display = 'none';
    }
    $('#confirmDialog').classList.add('show');
    const ok = () => { cleanup(); hideConfirm(); resolve(hasInput ? { action: true, reason: input.value } : true); };
    const cancel = () => { cleanup(); hideConfirm(); resolve(false); };
    const third = () => { cleanup(); hideConfirm(); resolve(hasInput ? { action: 'third', reason: input.value } : 'third'); };
    // 按钮焦点：←/→ 或 ↑/↓ 切换，Enter 触发当前高亮，Esc 取消
    const btns = [];
    if (thirdText) btns.push(thirdBtn);
    if (showCancel) btns.push($('#confirmCancel'));
    btns.push(okBtn);
    let kbIdx = btns.length - 1;  // 默认高亮「确认」
    const updateKbFocus = () => {
      btns.forEach((b, i) => b.classList.toggle('kb-focus', i === kbIdx));
    };
    updateKbFocus();
    const onKey = (e) => {
      // 输入框内：方向键保留光标移动（不切按钮高亮），Enter 直接确认
      if (hasInput && e.target === input) {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); ok(); }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        kbIdx = (kbIdx - 1 + btns.length) % btns.length; updateKbFocus();
      }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        kbIdx = (kbIdx + 1) % btns.length; updateKbFocus();
      }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); btns[kbIdx].click(); }
    };
    document.addEventListener('keydown', onKey, true);
    function cleanup() {
      document.removeEventListener('keydown', onKey, true);
      btns.forEach(b => b.classList.remove('kb-focus'));
      input.style.display = 'none';
    }
    $('#confirmOk').onclick = ok;
    $('#confirmCancel').onclick = cancel;
    thirdBtn.onclick = third;
    $('#confirmDialog').onclick = (e) => { if (e.target === $('#confirmDialog')) cancel(); };
  });
}
function hideConfirm() { $('#confirmDialog').classList.remove('show'); }

// ── 用户协议（初次访问强制阅读 5s，每浏览器独立）────
let agreementTimer = null;
let agreementForced = false;

function showUserAgreement(force) {
  agreementForced = !!force;
  $('#agreementModal').classList.add('show');
  const btn = $('#btnCloseAgreement');
  clearInterval(agreementTimer);
  if (force) {
    btn.disabled = true;
    let sec = 10;
    btn.textContent = `我已知晓并同意（${sec}s）`;
    agreementTimer = setInterval(() => {
      sec--;
      if (sec <= 0) {
        clearInterval(agreementTimer);
        btn.disabled = false;
        btn.textContent = '我已知晓并同意';
      } else {
        btn.textContent = `我已知晓并同意（${sec}s）`;
      }
    }, 1000);
  } else if (localStorage.getItem('agreement_accepted') === '1') {
    // 已同意：可点击，点击即关闭该页面
    btn.disabled = false;
    btn.textContent = '您已同意该协议';
  } else {
    btn.disabled = false;
    btn.textContent = '我已知晓并同意';
  }
}

$('#btnCloseAgreement').addEventListener('click', () => {
  localStorage.setItem('agreement_accepted', '1');
  clearInterval(agreementTimer);
  $('#agreementModal').classList.remove('show');
});

// 拒绝协议：任何模式都需弹窗确认，确认后删除同意记录并返回上一页
$('#btnRejectAgreement').addEventListener('click', async () => {
  clearInterval(agreementTimer);
  if (!(await showConfirm('若您拒绝将无法使用该软件。确定拒绝吗？', 'warning'))) {
    // 取消拒绝：强制模式恢复倒计时继续阅读，非强制保持弹窗
    if (agreementForced) showUserAgreement(true);
    return;
  }
  localStorage.removeItem('agreement_accepted');
  if (history.length > 1) history.back();
  else window.close();
});
$('#agreementModal').addEventListener('click', (e) => {
  // 强制模式（初次访问）不允许点遮罩跳过
  if (e.target === $('#agreementModal') && !agreementForced) $('#agreementModal').classList.remove('show');
});

// 初次访问：自动弹出协议（每个浏览器 localStorage 独立）
if (localStorage.getItem('agreement_accepted') !== '1') showUserAgreement(true);

// 加载协议内容（服务端 AGREEMENT.md）
// 协议专用渲染：按空行分段，标题/正文紧凑，无 <br> 空隙
function renderAgreement(md) {
  return md.split(/\n{2,}/).map(seg => {
    const t = seg.trim();
    if (!t) return '';
    if (/^#{1,6}\s/.test(t)) {
      const level = Math.min(t.match(/^#+/)[0].length, 3);
      return `<h${level}>${t.replace(/^#+\s*/, '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</h${level}>`;
    }
    return `<p>${t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, ' ')}</p>`;
  }).join('');
}

async function loadAgreement() {
  try {
    const r = await API('/api/agreement');
    const el = $('#agreementContent');
    if (r && r.ok && r.content) {
      el.innerHTML = renderAgreement(r.content);
    } else {
      el.innerHTML = '<p>协议内容加载失败</p>';
    }
  } catch (e) {
    $('#agreementContent').innerHTML = '<p>协议内容加载失败</p>';
  }
}
loadAgreement();

// ── 退出登录 ────────────────────────────────────────
$('#btnLogout').addEventListener('click', async () => {
  if (!(await showConfirm('确定要退出登录吗？'))) return;
  await API('/api/logout', { method: 'POST' });
  window.location.reload();
});

// ── 默认页面（主页/消息，localStorage 按浏览器独立）──
function setDefaultView(v) {
  localStorage.setItem('default_view', v);
  $('#defViewHome').classList.toggle('active', v === 'home');
  $('#defViewChat').classList.toggle('active', v === 'chat');
}
function setDefaultViewUI() {
  const dv = localStorage.getItem('default_view') || 'home';
  $('#defViewHome').classList.toggle('active', dv === 'home');
  $('#defViewChat').classList.toggle('active', dv === 'chat');
}

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

// ── 自定义主题色 ────────────────────────────────────
// --accent 深浅主题共用，:root 上覆盖一处即同改；--accent-hover 经 color-mix 自动派生
const ACCENT_PRESETS = ['#5865f2', '#3ba55c', '#ed4245', '#f0a040', '#9b59b6', '#e91e63', '#00bcd4', '#7c3aed'];
function applyAccent(hex) {
  const root = document.documentElement;
  if (hex) {
    root.style.setProperty('--accent', hex);
    localStorage.setItem('neonbot_accent', hex);
  } else {
    root.style.removeProperty('--accent');
    localStorage.removeItem('neonbot_accent');
  }
  const cur = hex || '#5865f2';
  document.querySelectorAll('.accent-swatch').forEach(s => s.classList.toggle('active', s.dataset.color === cur));
  const picker = $('#accentPicker');
  if (picker) picker.value = cur;
}

// 系统主题变化时，「自动」模式实时跟随
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    systemDark = e.matches;
    if (localStorage.getItem('neonbot_theme') === 'auto') setTheme('auto');
  });
}

// ── 启动 ─────────────────────────────────────────────
// 立即进入默认视图（同步执行，避免 init 异步完成后才切换造成「先消息后主页」闪烁；首次加载无动画）
setDefaultViewUI();
if ((localStorage.getItem('default_view') || 'home') === 'home') showHomeView(true);
else showChatView(true);
// init() 定义在 core.js，依赖本文件（settings.js）的函数，故在所有文件加载完后执行
init();

