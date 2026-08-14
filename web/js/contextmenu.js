// ── 右键菜单 ────────────────────────────────────────
let ctxTargetMsg = null;
let selectMode = false;
let selectedMsgs = new Set();
const $ctxMenu = $('#ctxMenu');
const $batchBar = $('#batchBar');
const $batchCount = $('#batchCount');

function onMsgContextMenu(e) {
  e.preventDefault();
  if (selectMode) return;
  if (this.classList.contains('center')) return;  // 撤回消息不弹菜单
  let content = this.dataset.msgContent || '';
  if (!content) {
    const bubble = this.querySelector('.msg-bubble');
    if (bubble) content = bubble.textContent.replace(/^\s+|\s+$/g, '');
  }
  // 提取原始 URL（去掉代理前缀）
  const unwrapUrl = (src) => {
    if (src.includes('/api/image?url=')) {
      return decodeURIComponent(src.split('/api/image?url=')[1]);
    }
    return src;
  };
  const imgs = this.querySelectorAll('.msg-image');
  const imgUrls = [...imgs].map(img => unwrapUrl(img.src || '')).filter(Boolean);
  const videos = this.querySelectorAll('.msg-video');
  const videoUrls = [...videos].map(v => unwrapUrl(v.src || '')).filter(Boolean);
  const audios = this.querySelectorAll('.msg-audio');
  const audioUrls = [...audios].map(a => unwrapUrl(a.src || '')).filter(Boolean);
  const asrEls = this.querySelectorAll('.asr-text');
  const asrTexts = [...asrEls].map(el => el.textContent || '').filter(Boolean);

  ctxTargetMsg = {
    id: parseInt(this.dataset.msgId) || 0,
    direction: this.dataset.msgDirection,
    content: content,
    imgUrls: imgUrls,
    videoUrls: videoUrls,
    audioUrls: audioUrls,
    asrTexts: asrTexts,
    sender_name: this.dataset.msgSender || '',
    sender_avatar: this.dataset.msgSenderAvatar || '',
    member_role: this.dataset.msgMemberRole || '',
    msg_type: parseInt(this.dataset.msgType) || 0,
    ref_idx: this.dataset.msgRefIdx || '',
    timestamp: this.dataset.msgTimestamp || '',
    el: this,
  };
  $('#ctxCopy').innerHTML = '<img src="icons/copy.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> 复制';
  // 恢复所有菜单项显示（头像右键禁言菜单可能隐藏过它们）
  ['ctxCopy', 'ctxForward', 'ctxFavorite', 'ctxQuote', 'ctxMultiSelect', 'ctxRecall', 'ctxDelete', 'ctxSep'].forEach(id => {
    $('#' + id).style.display = '';
  });
  $('#ctxMute').style.display = 'none';  // 禁言仅头像右键可见
  $('#ctxAt').style.display = 'none';    // @TA 仅头像右键可见
  // 撤回：
  //  - 机器人为群管理时：自己的任何消息都可撤回（不限 2 分钟），且可撤回普通群成员的消息
  //  - 普通身份：仅限自己发出 2 分钟内的消息（QQ 撤回时限）；私聊同样受限
  const conv = findConvAnywhere(currentConv);
  const botRole = (conv && conv.bot_role) || '';
  const botIsAdmin = ['owner', 'admin', '群主', '管理员'].includes(botRole);
  const memberIsNormal = !['owner', 'admin', '群主', '管理员'].includes(ctxTargetMsg.member_role);
  let recallOk = false;
  if (ctxTargetMsg.direction === 'outgoing') {
    if (botIsAdmin) {
      recallOk = true;  // 群管理撤回自己的任何消息
    } else {
      const ts = ctxTargetMsg.timestamp;
      if (ts) {
        const t = new Date(ts.replace(' ', 'T')).getTime();
        recallOk = !isNaN(t) && Date.now() - t <= 2 * 60 * 1000;
      }
    }
  } else if (botIsAdmin && memberIsNormal) {
    recallOk = true;  // 群管理可撤回普通成员的消息
  }
  $('#ctxRecall').style.display = recallOk ? '' : 'none';
  $('#ctxMultiSelect').style.display = '';
  $convCtxMenu.style.display = 'none';
  $clearCtxMenu.style.display = 'none';
  $ctxMenu.style.display = 'block';
  // 先显示才能量高度
  const menuH = $ctxMenu.offsetHeight || 120;
  let top = e.clientY;
  if (e.clientY + menuH > window.innerHeight) top = e.clientY - menuH;
  $ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - 160) + 'px';
  $ctxMenu.style.top = Math.max(0, top) + 'px';
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.context-menu')) {
    $ctxMenu.style.display = 'none';
    $convCtxMenu.style.display = 'none';
    $clearCtxMenu.style.display = 'none';
    // 不在这里清空 ctxTargetMsg，让转发/收藏弹窗还能用到
    // 弹窗关闭时各自负责清理
  }
});

// ── 聊天区空白右键/长按：清屏（仅清 DOM，不删记录）───────
const $clearCtxMenu = $('#clearCtxMenu');

// 清屏菜单（PC 右键空白 + 移动端长按空白共用）
function showClearCtxMenu(clientX, clientY) {
  $ctxMenu.style.display = 'none';
  $convCtxMenu.style.display = 'none';
  $clearCtxMenu.style.display = 'block';
  const menuH = $clearCtxMenu.offsetHeight || 60;
  let top = clientY;
  if (clientY + menuH > window.innerHeight) top = clientY - menuH;
  $clearCtxMenu.style.left = Math.min(clientX, window.innerWidth - 140) + 'px';
  $clearCtxMenu.style.top = Math.max(0, top) + 'px';
}

// 头像菜单（PC 右键头像 + 移动端长按头像共用）：弹「@TA」菜单；
// 机器人是群管理且对方是普通成员时再加「禁言」
function showAvatarCtxMenu(e, row) {
  const conv = findConvAnywhere(currentConv);
  const botRole = conv && conv.bot_role || '';
  const memberRole = row.dataset.msgMemberRole || '';
  const botIsAdmin = ['owner', 'admin', '群主', '管理员'].includes(botRole);
  const memberIsNormal = !['owner', 'admin', '群主', '管理员'].includes(memberRole);
  e.preventDefault();
  // 条件不满足（私聊/自己/无 OpenID）：不弹任何菜单
  if (!conv || conv.type !== 'group' || row.dataset.msgDirection === 'outgoing'
      || !row.dataset.msgSenderOpenid) return;
  // 复用消息菜单，仅显示「@TA」；管理且对方是普通成员时再加「禁言」
  ctxTargetMsg = {
    sender_openid: row.dataset.msgSenderOpenid || '',
    sender_name: row.dataset.msgSender || '',
    el: row,
  };
  ['ctxCopy', 'ctxForward', 'ctxFavorite', 'ctxQuote', 'ctxMultiSelect', 'ctxRecall', 'ctxDelete', 'ctxSep'].forEach(id => {
    $('#' + id).style.display = 'none';
  });
  $('#ctxAt').style.display = '';  // @TA：纯文本填充输入框
  if (botIsAdmin && memberIsNormal) {
    // 禁言状态来自 1s 轮询缓存（mutedMembers），右键时同步判断，无网络等待
    const muted = mutedMembers.has(row.dataset.msgSenderOpenid);
    ctxTargetMsg.muted = muted;
    $('#ctxMute').innerHTML = muted
      ? '<img src="icons/unmute.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> 解除禁言'
      : '<img src="icons/mute.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> 禁言';
    $('#ctxMute').style.display = '';
  } else {
    $('#ctxMute').style.display = 'none';  // 对方是管理/群主：只弹 @TA
  }
  $convCtxMenu.style.display = 'none';
  $clearCtxMenu.style.display = 'none';
  $ctxMenu.style.display = 'block';
  const menuH = $ctxMenu.offsetHeight || 120;
  let top = e.clientY;
  if (e.clientY + menuH > window.innerHeight) top = e.clientY - menuH;
  $ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - 160) + 'px';
  $ctxMenu.style.top = Math.max(0, top) + 'px';
}

$messages.addEventListener('contextmenu', (e) => {
  // 右键成员头像：艾特/禁言菜单
  const avatarCol = e.target.closest ? e.target.closest('.msg-avatar-col') : null;
  if (avatarCol) {
    const row = avatarCol.closest('.msg-row');
    if (row) showAvatarCtxMenu(e, row);
    return;
  }
  // 气泡/媒体内容区由消息菜单处理，其余全部走清屏菜单
  const contentEl = e.target.closest ? e.target.closest('.msg-bubble, .img-placeholder, .msg-audio, .file-card') : null;
  if (contentEl) return;
  e.preventDefault();
  showClearCtxMenu(e.clientX, e.clientY);
});

$('#ctxClearScreen').addEventListener('click', () => {
  $clearCtxMenu.style.display = 'none';
  $messages.innerHTML = '';
  hideJumpBtn();  // 清屏后消息区归零，按钮不再有意义
  showToast('✓ 已清屏');
});

// ── iOS Safari：长按消息 = 右键菜单 ──────────────────
let longPressTimer = null;
let longPressX = 0, longPressY = 0;
let longPressFired = false;
let longPressTarget = null;

$messages.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) return;
  const t = e.touches[0];
  longPressX = t.clientX;
  longPressY = t.clientY;
  longPressFired = false;
  longPressTarget = e.target;
  longPressTimer = setTimeout(() => {
    longPressFired = true;
    longPressTimer = null;
    const t = longPressTarget;
    // 长按头像 → 艾特/禁言菜单（与 PC 右键头像一致）
    const avatarCol = t.closest ? t.closest('.msg-avatar-col') : null;
    if (avatarCol) {
      const row = avatarCol.closest('.msg-row');
      if (row) showAvatarCtxMenu({ clientX: longPressX, clientY: longPressY, preventDefault: () => {} }, row);
      return;
    }
    const row = t.closest ? t.closest('.msg-row') : null;
    if (!row) { showClearCtxMenu(longPressX, longPressY); return; }  // 消息区空白 → 清屏菜单
    // 气泡/媒体 → 消息菜单；行内空白 → 清屏菜单（onMsgContextMenu 只管消息菜单，
    // 清屏分支在外层 contextmenu handler 里，长按不经过它，需自行分流）
    const contentEl = t.closest ? t.closest('.msg-bubble, .img-placeholder, .msg-audio, .file-card') : null;
    if (contentEl) {
      const ev = { clientX: longPressX, clientY: longPressY, preventDefault: () => {}, target: t };
      onMsgContextMenu.call(row, ev);
    } else {
      showClearCtxMenu(longPressX, longPressY);
    }
  }, 500);
}, { passive: true });

$messages.addEventListener('touchmove', (e) => {
  if (!longPressTimer) return;
  const t = e.touches[0];
  if (Math.abs(t.clientX - longPressX) > 10 || Math.abs(t.clientY - longPressY) > 10) {
    clearTimeout(longPressTimer);
    longPressTimer = null;  // 移动即取消（滚动/滑动）
  }
}, { passive: true });

$messages.addEventListener('touchend', () => {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
});

// 长按触发菜单后，阻止抬起手指时产生的点击穿透（如打开灯箱）
$messages.addEventListener('click', (e) => {
  if (longPressFired) {
    longPressFired = false;
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

// ── 成员信息卡片（点击头像 / 撤回提示蓝字，在点击位置弹出） ──
// isSelf=true（自己的消息）：头像用设置里配置的个性头像（getBotAvatar），
// 消息记录本身没存 sender_avatar；未配置时才兜底 bot.svg 图标
function showMemberCard(e, openid, name, avatar, isSelf, anchored = false) {
  const card = $('#memberCard');
  if (!card || !openid) return;  // 无 OpenID（如禁言气泡）不弹
  card.dataset.self = isSelf ? '1' : '';
  if (isSelf) avatar = getBotAvatar() || avatar;  // 自己的消息 → 设置的个性头像
  const avEl = $('#mcAvatar');
  if (avatar) {
    avEl.innerHTML = `<img src="${escHtml(avatar)}" alt="" onerror="this.onerror=null;mcAvatarFallback()" onclick="event.stopPropagation();viewImage('${escHtml(avatar)}')">`;
  } else {
    mcAvatarFallback();
  }
  card.dataset.bot = (name && name.includes('🤖')) ? '1' : '';  // 机器人标记：刷新昵称时保留 bot.svg
  $('#mcName').innerHTML = fmtBotMarker(name || '未知成员');  // 🤖 → bot.svg 图标
  // 自己 → 显示设置的个性签名（bio）；他人 → 显示 OpenID
  $('#mcId').textContent = isSelf ? (getBio() || '未设置签名') : ('OpenID: ' + openid);
  card.style.display = 'block';
  card.dataset.anchored = anchored ? '1' : '';
  if (anchored) {
    // 锚定模式：对齐群信息卡片的位置（群卡片是 absolute 相对 chat-area，
    // 这里用 fixed 需把 chat-area 的视口偏移算进去）+ 顶栏用户名高亮
    const ca = document.getElementById('chatArea').getBoundingClientRect();
    card.style.left = (ca.left + 20) + 'px';
    card.style.top = (ca.top + 66) + 'px';
    $chatName.classList.add('card-open');
    refreshMemberCard(openid, card, avEl);
    return;
  }
  // 定位在点击位置右侧下方，超出视口则翻转
  const r = card.getBoundingClientRect();
  let x = e.clientX + 12, y = e.clientY + 12;
  if (x + r.width > window.innerWidth - 8) x = Math.max(8, e.clientX - r.width - 12);
  if (y + r.height > window.innerHeight - 8) y = Math.max(8, e.clientY - r.height - 12);
  card.style.left = x + 'px';
  card.style.top = y + 'px';
  refreshMemberCard(openid, card, avEl);
}

// 头像 URL 是否相同（img.src 是解析后的绝对 URL，后端可能返回相对路径，统一解析后比较）
function sameAvatar(imgEl, url) {
  if (!imgEl || !url) return false;
  try { return imgEl.src === new URL(url, location.origin).href; }
  catch (e) { return imgEl.src === url; }
}

// 弹出成员卡片后自动拉取该成员最新昵称/头像（后端 10 分钟缓存，不会频繁调第三方接口）；
// 卡片仍开着才更新显示，失败静默保留旧值
function refreshMemberCard(openid, card, avEl) {
  if (card.dataset.self === '1') return;  // 机器人自己的头像走设置里的个性头像，不用 qlogo 拉取
  API(`/api/user-info/${encodeURIComponent(openid)}`).then(r => {
    if (!r || !r.ok || card.style.display === 'none') return;
    if (r.name) {
      const nm = card.dataset.bot === '1' ? r.name + ' 🤖' : r.name;  // 保留机器人标记，避免 bot.svg 消失
      $('#mcName').innerHTML = fmtBotMarker(nm);
    }
    if (r.avatar_url) {
      // 新头像与原头像相同则不重写 DOM（避免无意义的重新加载/闪烁）
      const curImg = avEl.querySelector('img');
      if (!sameAvatar(curImg, r.avatar_url)) {
        avEl.innerHTML = `<img src="${escHtml(r.avatar_url)}" alt="" onerror="this.onerror=null;mcAvatarFallback()" onclick="event.stopPropagation();viewImage('${escHtml(r.avatar_url)}')">`;
      }
      // 同步更新消息列表里该成员的头像与昵称（含 dataset，后续点卡片/右键用最新值）
      const rows = document.querySelectorAll(`#messages .msg-row[data-msg-sender-openid="${CSS.escape(openid)}"]`);
      rows.forEach(row => {
        const img = row.querySelector('.msg-avatar-img');
        if (!sameAvatar(img, r.avatar_url)) {
          row.dataset.msgSenderAvatar = r.avatar_url;
          if (img) img.src = r.avatar_url;
        }
        if (r.name && row.dataset.msgDirection !== 'outgoing') {
          // 原名字带 🤖（机器人标记）时给新昵称补回，避免重建 meta 后 bot.svg 图标消失
          const oldName = row.dataset.msgSender || '';
          const newName = oldName.includes('🤖') ? r.name + ' 🤖' : r.name;
          row.dataset.msgSender = newName;
          const meta = row.querySelector('.msg-meta');
          if (meta) meta.outerHTML = msgMetaHtml('incoming', newName, row.dataset.msgMemberRole || '');
        }
      });
    }
  }).catch(() => {});
}

// 卡片头像兜底：自己且未配置个性头像 → bot.svg 图标；他人 → 昵称首字符
function mcAvatarFallback() {
  const card = $('#memberCard');
  const avEl = $('#mcAvatar');
  if (!card || !avEl) return;
  if (card.dataset.self === '1') {
    avEl.innerHTML = '<img src="icons/bot.svg" class="svg-icon" alt="" style="width:55%;height:55%;">';
  } else {
    avEl.textContent = ($('#mcName').textContent || '?')[0];
  }
}

function hideMemberCard() {
  const card = $('#memberCard');
  if (card) {
    card.style.display = 'none';
    // 锚定模式打开的卡片关闭时，取消顶栏用户名高亮
    if (card.dataset.anchored === '1') $chatName.classList.remove('card-open');
  }
}

// 头像 / 撤回提示蓝字 → 弹成员卡片（stopPropagation 防止被 document 监听立即关闭）
$messages.addEventListener('click', (e) => {
  const row = e.target.closest('.msg-row');
  if (!row) return;
  const isSelf = row.dataset.msgDirection === 'outgoing';
  // 私聊消息的 sender_name 是对方 OpenID、sender_avatar 为空——用会话显示名/头像兜底
  let sName = row.dataset.msgSender, sAvatar = row.dataset.msgSenderAvatar;
  if (currentConvType === 'direct' && !isSelf) {
    const conv = conversations.find(c => c.id === currentConv);
    sName = senderDisplayName(sName, currentConv);
    if (!sAvatar) sAvatar = (conv && conv.avatar_url) || '';
  }
  const blue = e.target.closest('.mute-member-name');
  if (blue) {
    showMemberCard(e, row.dataset.msgSenderOpenid, sName, sAvatar, isSelf);
    e.stopPropagation();
    return;
  }
  if (e.target.closest('.msg-avatar-col')) {
    showMemberCard(e, row.dataset.msgSenderOpenid, sName, sAvatar, isSelf);
    e.stopPropagation();
  }
});

// 点击卡片外部 / Esc / 消息区滚动 → 关闭成员卡片
document.addEventListener('click', (e) => {
  const card = $('#memberCard');
  if (!card || card.style.display === 'none') return;
  if (!card.contains(e.target)) hideMemberCard();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideMemberCard();
});
$messages.addEventListener('scroll', hideMemberCard);

// ── 会话右键菜单（置顶 / 免打扰 / 不显示）───────────────
const $convCtxMenu = $('#convCtxMenu');
let ctxConvId = null;

function findConvAnywhere(id) {
  return (searchResults || conversations).find(c => c.id === id) || null;
}

$convList.addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.conv-item');
  if (!item) return;
  e.preventDefault();
  ctxConvId = item.dataset.id;
  const conv = findConvAnywhere(ctxConvId);
  if (!conv) return;
  $('#convCtxPin').innerHTML = `<img src="icons/up.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> ${conv.pinned ? '取消置顶' : '置顶'}`;
  $('#convCtxMute').innerHTML = `<img src="icons/${conv.muted ? 'disturb' : 'donotdisturb'}.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> ${conv.muted ? '取消免打扰' : '消息免打扰'}`;
  $('#convCtxHide').innerHTML = `<img src="icons/${conv.hidden ? 'show' : 'hidden'}.svg" class="svg-icon" style="width:16px;height:16px;" alt=""> ${conv.hidden ? '显示会话' : '不显示会话'}`;
  $ctxMenu.style.display = 'none';
  $clearCtxMenu.style.display = 'none';
  $convCtxMenu.style.display = 'block';
  const menuH = $convCtxMenu.offsetHeight || 120;
  let top = e.clientY;
  if (e.clientY + menuH > window.innerHeight) top = e.clientY - menuH;
  $convCtxMenu.style.left = Math.min(e.clientX, window.innerWidth - 160) + 'px';
  $convCtxMenu.style.top = Math.max(0, top) + 'px';
});

async function toggleConvFlag(field) {
  const conv = findConvAnywhere(ctxConvId);
  if (!conv) return;
  const newVal = conv[field] ? 0 : 1;
  $convCtxMenu.style.display = 'none';
  let r;
  try {
    r = await API(`/api/conversations/${encodeURIComponent(ctxConvId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: newVal }),
    });
  } catch (e) {
    showToast('⚠ 网络错误'); return;
  }
  if (r && r.error) { showToast('⚠ ' + r.error); return; }
  conv[field] = newVal;
  // 隐藏会话：从可见列表移除；若正在查看则关闭聊天区
  if (field === 'hidden' && newVal) {
    const i = conversations.findIndex(c => c.id === ctxConvId);
    if (i >= 0) conversations.splice(i, 1);
    if (currentConv === ctxConvId) closeChatToHome();
  }
  renderConvList($searchInput.value);
  const label = field === 'pinned' ? (newVal ? '已置顶' : '已取消置顶')
    : field === 'muted' ? (newVal ? '已开启免打扰' : '已取消免打扰')
    : (newVal ? '已隐藏会话' : '已恢复显示');
  showToast('✓ ' + label);
}

$('#convCtxPin').addEventListener('click', () => toggleConvFlag('pinned'));
$('#convCtxMute').addEventListener('click', () => toggleConvFlag('muted'));
$('#convCtxHide').addEventListener('click', () => toggleConvFlag('hidden'));

// 删除聊天：删除聊天记录 + 会话 tab
$('#convCtxDelete').addEventListener('click', async () => {
  if (!ctxConvId) return;
  $convCtxMenu.style.display = 'none';
  if (!(await showConfirm('确定删除该聊天及其全部聊天记录吗？此操作不可恢复。', 'query'))) return;
  try {
    const r = await API(`/api/conversations/${encodeURIComponent(ctxConvId)}`, { method: 'DELETE' });
    if (r && r.error) { showToast('⚠ ' + r.error); return; }
  } catch (e) { showToast('⚠ 网络错误'); return; }
  // 本地移除
  const i = conversations.findIndex(c => c.id === ctxConvId);
  if (i >= 0) conversations.splice(i, 1);
  if (searchResults) {
    const si = searchResults.findIndex(c => c.id === ctxConvId);
    if (si >= 0) searchResults.splice(si, 1);
  }
  // 若正在查看该会话，关闭聊天区
  if (currentConv === ctxConvId) closeChatToHome();
  renderConvList($searchInput.value);
  showToast('✓ 已删除聊天');
});

// ── 收藏 ─────────────────────────────────────────────
function getFavorites() {
  try { return JSON.parse(localStorage.getItem('neonbot_fav') || '[]'); }
  catch { return []; }
}
function saveFavorites(favs) { localStorage.setItem('neonbot_fav', JSON.stringify(favs)); }

// 单聊消息的 sender_name 存的是对方 OpenID（32 位十六进制串，旧版可能为纯数字）——显示时用会话名代替
function looksLikeOpenId(s) {
  return !!s && s.length >= 16 && /^[0-9a-fA-F-]+$/.test(s);
}
function senderDisplayName(raw, convId) {
  const conv = conversations.find(c => c.id === convId);
  const fallback = conv ? (conv.display_name || conv.name || conv.id) : '';
  const name = (raw || '').trim();
  return (!name || looksLikeOpenId(name)) ? (fallback || name) : name;
}

function renderFavList() {
  const favs = getFavorites();
  const $favList = $('#favList');
  if (favs.length === 0) {
    $favList.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:20px;">暂无收藏</div>';
    return;
  }
  $favList.innerHTML = [...favs].reverse().map((f, i) => {
    // 群消息：显示「来自 群名」，不显示成员身份徽章；私聊不显示来源（sender 已是对方昵称）
    const favConv = conversations.find(c => c.id === f.conv_id);
    const fromHtml = favConv && favConv.type !== 'direct'
      ? ` · 来自 ${escHtml(favConv.display_name || favConv.name || favConv.id)}`
      : '';
    const favAvatar = f.avatar || (favConv && favConv.avatar_url) || '';
    return `
    <div style="padding:8px;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;gap:8px;">
      ${favAvatar ? `<img src="${escHtml(favAvatar)}" style="width:32px;height:32px;border-radius:50%;flex-shrink:0;margin-top:2px;" onerror="this.style.display='none'">` : ''}
      <div style="min-width:0;flex:1;">
        <div style="font-size:0.75em;color:var(--text-dim);">${escHtml(senderDisplayName(f.sender, f.conv_id))}${fromHtml} · ${escHtml(f.time || '')}</div>
        ${(f.imgUrls || []).map(u => `<a href="${escHtml(u)}" target="_blank"><img src="${escHtml(u)}" style="max-width:100%;max-height:300px;border-radius:6px;display:block;margin:4px 0;cursor:pointer;" onerror="this.style.display='none'"></a>`).join('')}
        ${(f.videoUrls || []).map(u => `<video src="${escHtml(u)}" controls preload="metadata" style="max-width:100%;max-height:300px;border-radius:6px;display:block;margin:4px 0;" onerror="this.style.display='none'"></video>`).join('')}
        ${(f.audioUrls || []).map(u => `<audio src="${escHtml(u)}" controls preload="metadata" style="display:block;margin:4px 0;width:100%;min-width:200px;" onerror="this.style.display='none'"></audio>`).join('')}
        ${(f.asrTexts || []).map(t => `<div class="asr-text">${escHtml(t)}</div>`).join('')}
        ${f.content && !['[图片]','[视频]','[语音]'].includes(f.content) ? `<div style="font-size:0.9em;word-break:break-word;">${escHtmlWithBr(f.content)}</div>` : (!f.imgUrls && !f.videoUrls && !f.audioUrls ? `<div style="font-size:0.9em;color:var(--text-dim);font-style:italic;">${escHtml(f.content || '[消息]')}</div>` : '')}
      </div>
      <button style="background:none;border:none;color:var(--danger);cursor:pointer;flex-shrink:0;" onclick="removeFav(${i})" title="取消收藏">✕</button>
    </div>
  `;
  }).join('');
}

function addFavorite(msg) {
  const favs = getFavorites();
  favs.push({
    content: msg.content || '',
    imgUrls: msg.imgUrls || [],
    videoUrls: msg.videoUrls || [],
    audioUrls: msg.audioUrls || [],
    asrTexts: msg.asrTexts || [],
    sender: senderDisplayName(msg.sender_name, currentConv) || '',
    // 私聊消息的 sender_avatar 通常为空——用会话头像兜底
    avatar: msg.sender_avatar || (conversations.find(c => c.id === currentConv) || {}).avatar_url || '',
    member_role: msg.member_role || '',
    time: (msg.timestamp || '').substring(0, 16),
    conv_id: currentConv || '',
    saved_at: new Date().toISOString(),
  });
  saveFavorites(favs);
}

async function removeFav(idx) {
  if (!(await showConfirm('确定取消收藏这条消息吗？'))) return;
  const favs = getFavorites();
  favs.splice(favs.length - 1 - idx, 1);
  saveFavorites(favs);
  renderFavList();
}

// ── 右键菜单事件 ──────────────────────────────────────
$('#ctxCopy').addEventListener('click', async () => {
  $ctxMenu.style.display = 'none';
  const el = ctxTargetMsg?.el;
  const imgs = el?.querySelectorAll('.msg-image');
  if (imgs && imgs.length > 0) {
    try {
      const resp = await fetch(imgs[0].src);
      const blob = await resp.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      showToast('✅ 复制成功');
    } catch (e) {
      navigator.clipboard.writeText(imgs[0].src).catch(() => {});
      showToast('⚠ 已复制图片链接（不支持图片格式）');
    }
  } else if (ctxTargetMsg?.content) {
    navigator.clipboard.writeText(ctxTargetMsg.content).catch(() => {});
    showToast('✅ 复制成功');
  }
  $ctxMenu.style.display = 'none';
});

$('#ctxForward').addEventListener('click', () => {
  if (!ctxTargetMsg?.content && !ctxTargetMsg?.el?.querySelector('.msg-image')) return;
  // 填充目标列表（包括当前群聊）
  const $sel = $('#forwardTarget');
  $sel.innerHTML = conversations
    .map(c => `<option value="${escHtml(c.id)}"${c.id === currentConv ? ' selected' : ''}>${escHtml(c.display_name || c.name || c.id)}</option>`)
    .join('');
  $('#forwardModal').classList.add('show');
  $ctxMenu.style.display = 'none';
});

function closeForwardModal() {
  $('#forwardModal').classList.remove('show');
  ctxTargetMsg = null;
}
$('#btnCancelForward').addEventListener('click', closeForwardModal);
$('#forwardModal').addEventListener('click', (e) => { if (e.target === $('#forwardModal')) closeForwardModal(); });

$('#btnOkForward').addEventListener('click', async () => {
  const targetId = $('#forwardTarget').value;
  if (!targetId) return;
  // 目标群无主动消息权限：发送前先确认（取消则保持转发窗口）
  if (!(await ensureProactiveAllowed(targetId))) return;
  // 先关窗口，避免卡顿感
  $('#forwardModal').classList.remove('show');

  let content = ctxTargetMsg?.content || '';
  let msgType = ctxTargetMsg?.msg_type || 0;

  // 收集需要转发的媒体
  const imgs = ctxTargetMsg?.el?.querySelectorAll('.msg-image');
  const videos = ctxTargetMsg?.el?.querySelectorAll('.msg-video');
  const audios = ctxTargetMsg?.el?.querySelectorAll('.msg-audio');

  const getRawUrl = (el) => {
    let src = el.src || '';
    // blob URL 跳过
    if (src.startsWith('blob:')) return '';
    if (src.includes('/api/image?url=')) return decodeURIComponent(src.split('/api/image?url=')[1]);
    return src;
  };

  const mediaTasks = [];
  if (imgs && imgs.length > 0) mediaTasks.push(...[...imgs].map(el => ({ url: getRawUrl(el), type: 'image', ext: 'png' })).filter(m => m.url));
  if (videos && videos.length > 0) mediaTasks.push(...[...videos].map(el => ({ url: getRawUrl(el), type: 'video', ext: 'mp4' })).filter(m => m.url));
  if (audios && audios.length > 0) mediaTasks.push(...[...audios].map(el => ({ url: getRawUrl(el), type: 'voice', ext: 'wav' })).filter(m => m.url));

  if (mediaTasks.length > 0) {
    for (const m of mediaTasks) {
      showToast(`⏳ 转发${m.type === 'image' ? '图片' : m.type === 'video' ? '视频' : '语音'}中…`);
      try {
        // 图床直链或语音直接使用，其他的先上传到图床
        const isDirect = isFileServerUrl(m.url) || m.type === 'voice';
        let fileUrl = m.url;
        if (!isDirect) {
          const resp = await fetch('/api/image?url=' + encodeURIComponent(m.url));
          const blob = await resp.blob();
          const form = new FormData();
          form.append('file', blob, 'media.' + m.ext);
          const upR = await fetch('/api/upload-file', { method: 'POST', body: form }).then(r => r.json());
          if (upR.code !== 200) { showToast('⚠ 图床上传失败'); continue; }
          fileUrl = upR.url || (fileServerUrl ? `${fileServerUrl}/get/${upR.file_id}` : upR.url || '');
        }
        const sendR = await API('/api/send-media', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conv_id: targetId, url: fileUrl, file_type: m.type }),
        });
        if (sendR.error) { showToast('⚠ ' + sendR.error); }
        else { showToast('✅ 已转发'); }
      } catch (e) { showToast('⚠ 转发失败'); }
    }
    return;
  }
  if (!content.trim()) { alert('没有可转发的内容'); return; }

  try {
    const r = await API('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conv_id: targetId, content, msg_type: msgType }),
    });
    if (r.error) { showToast('⚠ ' + r.error); }
  } catch (e) { showToast('⚠ 网络错误: ' + e.message); }
});

$('#ctxFavorite').addEventListener('click', () => {
  if (!ctxTargetMsg) return;
  const msg = ctxTargetMsg;
  addFavorite(msg);
  showToast('⭐ 已收藏');
  $ctxMenu.style.display = 'none';
});

$('#ctxRecall').addEventListener('click', async () => {
  if (!ctxTargetMsg?.id) return;
  $ctxMenu.style.display = 'none';
  try {
    const r = await API(`/api/recall/${ctxTargetMsg.id}`, { method: 'POST' });
    if (r.error) { showToast('⚠ ' + r.error); }
  } catch (e) { showToast('⚠ 网络错误: ' + e.message); }
});

$('#ctxQuote').addEventListener('click', () => {
  if (!ctxTargetMsg?.ref_idx) { showToast('⚠ 该消息无引用 ID'); $ctxMenu.style.display = 'none'; return; }
  // 收集引用消息的附件缩略图
  const quoteImgs = ctxTargetMsg.imgUrls || [];
  const quoteVideos = ctxTargetMsg.videoUrls || [];
  const quoteThumbs = [
    ...quoteImgs.map(u => ({ url: u, type: 'image' })),
    ...quoteVideos.map(u => ({ url: u, type: 'video' })),
  ];
  currentQuoteRef = {
    message_id: ctxTargetMsg.ref_idx,
    quoted_sender: ctxTargetMsg.sender_name || '未知用户',
    quoted_content: ctxTargetMsg.content || '',
    thumbs: quoteThumbs,
  };
  // 显示引用栏
  $('#inputQuoteSender').textContent = currentQuoteRef.quoted_sender;
  const placeholderKeys = ['[图片]', '[视频]', '[语音]', '[文件]'];
  let quoteText = currentQuoteRef.quoted_content || '';
  if (placeholderKeys.includes(quoteText) && (currentQuoteRef.thumbs || []).length > 0) {
    quoteText = '';
  }
  let thumbHtml = '';
  (currentQuoteRef.thumbs || []).forEach(t => {
    const isDirect = isFileServerUrl(t.url);
    const src = isDirect ? t.url : `/api/image?url=${encodeURIComponent(t.url)}`;
    thumbHtml += `<div class="input-quote-thumb">${t.type === 'image'
      ? `<img src="${escHtml(src)}" style="max-width:64px;max-height:48px;object-fit:contain;border-radius:4px;pointer-events:none;" alt="">`
      : `<video src="${escHtml(src)}" style="max-width:64px;max-height:48px;object-fit:contain;border-radius:4px;pointer-events:none;" muted></video>`
    }</div>`;
  });
  $('#inputQuoteText').innerHTML = (quoteText || '') + thumbHtml;
  $('#inputQuoteBar').style.display = 'flex';
  $('#msgInput').focus();
  $ctxMenu.style.display = 'none';
});

$('#inputQuoteClose').addEventListener('click', () => {
  currentQuoteRef = null;
  $('#inputQuoteBar').style.display = 'none';
});

$('#ctxMultiSelect').addEventListener('click', () => {
  enterSelectMode();
  // 把当前右键的消息自动选中
  if (ctxTargetMsg?.id) {
    selectedMsgs.add(ctxTargetMsg.id);
    ctxTargetMsg.el.classList.add('selected');
    updateBatchBar();
  }
  $ctxMenu.style.display = 'none';
});

$('#ctxDelete').addEventListener('click', async () => {
  if (!ctxTargetMsg?.id) return;
  $ctxMenu.style.display = 'none';
  if (!(await showConfirm('确定要删除这条消息吗？', 'query'))) return;
  try {
    const r = await API(`/api/message/${ctxTargetMsg.id}`, { method: 'DELETE' });
    if (r.error) { alert('删除失败: ' + r.error); }
  } catch (e) { alert('网络错误: ' + e.message); }
  $ctxMenu.style.display = 'none';
});

// ── 多选模式 ─────────────────────────────────────────
function enterSelectMode() {
  selectMode = true;
  selectedMsgs.clear();
  $messages.classList.add('select-mode');
  $batchBar.style.display = 'flex';
  updateBatchBar();
  // 绑定点击事件
  $messages.querySelectorAll('.msg-row').forEach(row => {
    if (row.classList.contains('center')) return; // 跳过撤回提示
    row.classList.add('selectable');
    row.onclick = (e) => {
      e.preventDefault();
      const mid = parseInt(row.dataset.msgId) || 0;
      if (!mid) return;
      if (selectedMsgs.has(mid)) {
        selectedMsgs.delete(mid);
        row.classList.remove('selected');
      } else {
        selectedMsgs.add(mid);
        row.classList.add('selected');
      }
      updateBatchBar();
    };
  });
}

function exitSelectMode() {
  selectMode = false;
  selectedMsgs.clear();
  $messages.classList.remove('select-mode');
  $messages.querySelectorAll('.msg-row').forEach(row => {
    row.classList.remove('selectable', 'selected');
    row.onclick = null;
  });
  $batchBar.style.display = 'none';
}

function updateBatchBar() {
  $batchCount.textContent = `已选 ${selectedMsgs.size} 条`;
}

$('#btnCancelSelect').addEventListener('click', exitSelectMode);

$('#btnBatchDelete').addEventListener('click', async () => {
  if (selectedMsgs.size === 0) return;
  if (!(await showConfirm(`确定要删除选中的 ${selectedMsgs.size} 条消息吗？`, 'query'))) return;
  try {
    const r = await API('/api/messages/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selectedMsgs] }),
    });
    if (r.error) { alert('删除失败: ' + r.error); return; }
    exitSelectMode();
  } catch (e) { alert('网络错误: ' + e.message); }
});

// ── 文件下载 ─────────────────────────────────────────
function fileIconName(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (['png','jpg','jpeg','gif','bmp','webp','svg','ico'].includes(ext)) return 'image';
  if (['mp4','avi','mov','mkv','wmv','flv','webm','ts'].includes(ext)) return 'video';
  if (['mp3','wav','ogg','flac','aac','m4a','amr','opus'].includes(ext)) return 'music';
  return 'documents';
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function downloadFile(url, filename, cardEl) {
  if (selectMode) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 如果 1 秒后下载没触发（可能链接过期），提示用户
  setTimeout(() => {
    if (cardEl && cardEl.parentElement) {
      // 链接可能已过期，给视觉提示但保留文件卡片
    }
  }, 1500);
}


// ── 禁言：头像右键 → 时长选择弹窗 → 调 /api/mute ──────
const MUTE_MAX_SECONDS = 30 * 24 * 3600;  // 最长 30 天
const MUTE_UNIT_SECONDS = { d: 24 * 3600, h: 3600, m: 60, s: 1 };
const MUTE_WHEEL_ITEM_H = 35;  // 滚轮每项高度（px），与 CSS 一致
const MUTE_UNITS = [
  { unit: 'd', label: '天', max: 30 },
  { unit: 'h', label: '时', max: 23 },
  { unit: 'm', label: '分', max: 59 },
  { unit: 's', label: '秒', max: 59 },
];

// ── 禁言状态轮询：进入群聊后每 1s 拉一次被禁言成员列表 ──
// 后端有 2s 缓存兜底（QQ API 30 QPM 限制），前端右键菜单直接读此缓存，无网络等待
let mutedMembers = new Set();
let mutePollTimer = null;

function stopMutePolling() {
  if (mutePollTimer) { clearInterval(mutePollTimer); mutePollTimer = null; }
  mutedMembers.clear();
}

async function mutePollTick(convId) {
  try {
    const r = await API(`/api/mute-status/${encodeURIComponent(convId)}`);
    if (r && r.ok) mutedMembers = new Set((r.members || []).map(m => m.member_openid));
    // 失败静默：保留旧状态，后端有缓存旧值也会返回
  } catch (e) { /* 忽略网络错误 */ }
}

function startMutePolling(convId) {
  stopMutePolling();
  // 机器人不是群管理员时无禁言权限：不轮询（后端也会拦截，双保险，避免打爆 QQ API 30 QPM）
  const conv = findConvAnywhere(convId);
  const role = conv && conv.bot_role;
  if (role && !['owner', 'admin', '群主', '管理员'].includes(role)) return;
  mutePollTick(convId);
  mutePollTimer = setInterval(() => mutePollTick(convId), 1000);
}

// @TA：右键头像菜单 → 输入框光标处填充 "@昵称 "（伪@，纯文本，不调 API）
$('#ctxAt').addEventListener('click', () => {
  $ctxMenu.style.display = 'none';
  const name = (ctxTargetMsg && ctxTargetMsg.sender_name) || '';
  if (!name) return;
  const el = $msgInput;
  el.focus();
  const pos = el.selectionStart != null ? el.selectionStart : el.value.length;
  const t = el.value;
  el.value = t.slice(0, pos) + '@' + name + ' ' + t.slice(pos);
  const np = pos + 1 + name.length + 1;
  el.selectionStart = el.selectionEnd = np;
  el.dispatchEvent(new Event('input'));  // 触发高度调整
});

$('#ctxMute').addEventListener('click', () => {
  $ctxMenu.style.display = 'none';
  if (!ctxTargetMsg || !ctxTargetMsg.sender_openid) {
    showToast('无法获取成员标识');
    return;
  }
  // 该成员处于禁言中 → 直接解除
  if (ctxTargetMsg.muted) {
    const memberName = ctxTargetMsg.sender_name || '该成员';  // 先捕获，异步返回后可能被覆盖
    const memberOid = ctxTargetMsg.sender_openid || '';
    API('/api/mute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conv_id: currentConv, member_openid: ctxTargetMsg.sender_openid, op: 'del' }),
    }).then(r => {
      if (r && r.ok) appendMuteBubble(memberName, '', memberOid);  // 气泡即提示，不弹 toast
      else showToast('解除禁言失败：' + ((r && r.error) || '未知错误'));
    }).catch(err => showToast('解除禁言失败：' + err));
    return;
  }
  // 禁言：时长选择弹窗，默认全 0（保证天可一路滚到 30 不超限）
  document.querySelectorAll('#muteWheels .mute-wheel').forEach(wheel => {
    setMuteWheel(wheel, parseInt(wheel.dataset.rows));
  });
  updateMuteTotal();
  $('#muteTargetName').textContent = `成员：${ctxTargetMsg.sender_name || '未知成员'}`;
  $('#muteModal').classList.add('show');
});

function muteSeconds() {
  let total = 0;
  document.querySelectorAll('#muteWheels .mute-wheel').forEach(wheel => {
    total += (parseInt(wheel.dataset.val) || 0) * MUTE_UNIT_SECONDS[wheel.dataset.unit];
  });
  return total;
}

// ── 滚轮选择器：滚动 / 触摸拖动 / 点击选择，无输入框；无限循环滚动 ──
// 循环原理：每列渲染 3 份相同的数字，允许滚动范围 = 中间份 + 前后各 1 格边界扩展区；
// 跨越边界（max→0 / 0→max）是一格正常动画；越出 3 份范围时跳到内容相同的等效位置（无动画，视觉无感）。
const MUTE_REPEATS = 3;

function buildMuteWheels() {
  const box = $('#muteWheels');
  box.innerHTML = '';
  MUTE_UNITS.forEach(u => {
    const col = document.createElement('div');
    col.className = 'mute-wheel-col';
    const wheel = document.createElement('div');
    wheel.className = 'mute-wheel';
    wheel.dataset.unit = u.unit;
    wheel.dataset.max = u.max;
    wheel.dataset.rows = u.max + 1;
    const list = document.createElement('div');
    list.className = 'wheel-list';
    for (let rep = 0; rep < MUTE_REPEATS; rep++) {
      for (let i = 0; i <= u.max; i++) {
        const item = document.createElement('div');
        item.className = 'wheel-item';
        item.dataset.idx = i;
        item.dataset.rep = rep;
        item.textContent = i;
        list.appendChild(item);
      }
    }
    wheel.appendChild(list);
    col.appendChild(wheel);
    col.insertAdjacentHTML('afterbegin', `<div class="mute-wheel-label">${u.label}</div>`);
    box.appendChild(col);
  });
  // 初始化：列表定位到 0，保证打开弹窗前就有正确视图
  document.querySelectorAll('#muteWheels .mute-wheel').forEach(wheel => setMuteWheel(wheel, parseInt(wheel.dataset.rows)));
  document.querySelectorAll('#muteWheels .mute-wheel').forEach(wheel => {
    // 鼠标滚轮：向上滚 = 数值增大，循环滚动
    wheel.addEventListener('wheel', (e) => {
      e.preventDefault();
      muteWheelStep(wheel, e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
    // 触摸拖动：手指下拉 = 数值减小，每滑动一项高度切换一格，循环滚动
    let touchStartY = 0, touchStartRaw = 0;
    wheel.addEventListener('touchstart', (e) => {
      touchStartY = e.touches[0].clientY;
      touchStartRaw = parseInt(wheel.dataset.raw) || parseInt(wheel.dataset.rows);
    }, { passive: true });
    wheel.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const delta = e.touches[0].clientY - touchStartY;
      tryApplyMuteValue(wheel, touchStartRaw - Math.round(delta / MUTE_WHEEL_ITEM_H));
    }, { passive: false });
    // 点击数字直接选中
    wheel.addEventListener('click', (e) => {
      const item = e.target.closest('.wheel-item');
      if (item) tryApplyMuteValue(wheel, parseInt(wheel.dataset.rows) + (parseInt(item.dataset.idx) || 0));
    });
  });
}

// 把绝对行位置规整到 [rows-1, 2*rows]（中间份 + 前后各 1 格边界扩展区）
function normalizeMuteRaw(wheel, raw) {
  const rows = parseInt(wheel.dataset.rows);
  while (raw < rows - 1) raw += rows;
  while (raw > 2 * rows) raw -= rows;
  return raw;
}

// 从当前绝对位置前进/后退一格：若位于边界扩展区，先无动画跳回中间份等效位置
// （内容相同，视觉无感），再正常滚动一格（内容变化保持动画）
function muteWheelStep(wheel, delta) {
  const rows = parseInt(wheel.dataset.rows);
  let raw = parseInt(wheel.dataset.raw) || rows;
  if (raw > 2 * rows - 1) setMuteWheel(wheel, raw - rows);
  else if (raw < rows) setMuteWheel(wheel, raw + rows);
  raw = parseInt(wheel.dataset.raw);
  tryApplyMuteValue(wheel, raw + delta);
}

// 找出与当前显示位置最近的重复份（决定哪一份高亮）
function nearestMuteRep(wheel, v) {
  const rows = parseInt(wheel.dataset.rows);
  const raw = parseInt(wheel.dataset.raw);
  let best = 1, bestD = Infinity;
  for (let r = 0; r < MUTE_REPEATS; r++) {
    const d = Math.abs((r * rows + v) - raw);
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

// raw 为绝对行位置（0..3*rows-1）；显示值 v 由 raw 换算
// forceAnimate=true 时强制走过渡动画（如天=30 时其他滚轮归零）
function setMuteWheel(wheel, raw, forceAnimate) {
  const rows = parseInt(wheel.dataset.rows);
  raw = normalizeMuteRaw(wheel, raw);
  const v = ((raw - rows) % rows + rows) % rows;  // 0..max
  const list = wheel.querySelector('.wheel-list');
  const prevRaw = parseInt(wheel.dataset.raw);
  // 相邻两次位置差 >1 格 = 跨份跳转（内容相同）→ 临时去掉过渡动画；普通滚动/边界跨越保持动画
  const jumping = !forceAnimate && !isNaN(prevRaw) && Math.abs(raw - prevRaw) > 1;
  if (jumping) list.style.transition = 'none';
  wheel.dataset.val = v;
  wheel.dataset.raw = raw;
  list.style.transform = `translateY(${(wheel.offsetHeight - MUTE_WHEEL_ITEM_H) / 2 - raw * MUTE_WHEEL_ITEM_H}px)`;
  if (jumping) {
    // 强制重排：让「无过渡 + 新位置」立即落定，再恢复过渡，
    // 否则同帧内紧随的滚动会把跳转合并成一次大跨度动画
    void list.offsetHeight;
    list.style.transition = '';
  }
  const nr = nearestMuteRep(wheel, v);
  list.querySelectorAll('.wheel-item').forEach(item => {
    item.classList.toggle('active', parseInt(item.dataset.idx) === v && parseInt(item.dataset.rep) === nr);
  });
}

// 应用新值：允许全 0；合计超 30 天时不锁死滚轮，而是自动让其他单位让步
function tryApplyMuteValue(wheel, raw) {
  setMuteWheel(wheel, raw);
  if (wheel.dataset.unit === 'd' && parseInt(wheel.dataset.val) >= 30) {
    // 天滚到 30：时/分/秒 自动全清零（30 天即上限，再带单位就超限），带动画
    document.querySelectorAll('#muteWheels .mute-wheel').forEach(w => {
      if (w !== wheel) setMuteWheel(w, parseInt(w.dataset.rows), true);
    });
  } else if (muteSeconds() > MUTE_MAX_SECONDS) {
    // 其他单位有值且天=30 导致超限：天自动让步到 29，带动画
    const dWheel = document.querySelector('#muteWheels .mute-wheel[data-unit="d"]');
    if (dWheel) setMuteWheel(dWheel, parseInt(dWheel.dataset.rows) + 29, true);
  }
  updateMuteTotal();
}

buildMuteWheels();

function formatMuteDuration(total) {
  const d = Math.floor(total / 86400), h = Math.floor(total % 86400 / 3600);
  const m = Math.floor(total % 3600 / 60), s = total % 60;
  const parts = [];
  if (d) parts.push(d + '天');
  if (h) parts.push(h + '小时');
  if (m) parts.push(m + '分钟');
  if (s) parts.push(s + '秒');
  return parts.join('');  // 单位间无空格
}

function updateMuteTotal() {
  const total = muteSeconds();
  if (total <= 0) { $('#muteTotal').textContent = '请选择时长'; return; }
  $('#muteTotal').textContent = `共 ${formatMuteDuration(total)}`;
}

// 禁言/解除禁言成功后：消息底部追加一条居中气泡（类似「你撤回了一条消息」）
// durationText 传空串时显示「XXX 被你解除禁言」；同时持久化到消息表，刷新后仍可见
function appendMuteBubble(memberName, durationText, openid) {
  const div = document.createElement('div');
  div.className = 'msg-row center';
  div.dataset.msgSenderOpenid = openid || '';  // 点蓝字弹成员卡片需要 openid
  div.dataset.msgSender = memberName || '';
  div.innerHTML = `<div class="msg-bubble"><span class="mute-member-name">${escHtml(memberName)}</span>被你${durationText ? `禁言${escHtml(durationText)}` : '解除禁言'}</div>`;
  $messages.appendChild(div);
  scrollBottom();
  // 存库（direction=center），静默失败不影响展示
  // 成功后回填 id：防止 5s 增量刷新把已显示的气泡再渲染一份（双重回显）
  API('/api/system-note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conv_id: currentConv,
      member_name: memberName,
      sender_openid: openid || '',
      content: durationText ? `被你禁言${durationText}` : '被你解除禁言',
    }),
  }).then(r => {
    if (r && r.id) {
      lastMsgId = Math.max(lastMsgId, r.id);
      div.dataset.msgId = r.id;  // 增量刷新去重兜底
    }
  }).catch(() => {});
}

$('#btnOkMute').addEventListener('click', async () => {
  const total = muteSeconds();
  if (total <= 0) { showToast('请选择禁言时长'); return; }
  if (!ctxTargetMsg || !ctxTargetMsg.sender_openid) { showToast('无法获取成员标识'); return; }
  // 先捕获成员名/时长（异步返回后 ctxTargetMsg 可能已被下一次右键覆盖）
  const memberName = ctxTargetMsg.sender_name || '该成员';
  const memberOid = ctxTargetMsg.sender_openid || '';
  const durationText = formatMuteDuration(total);
  // 立即关闭弹窗，避免等待网络请求造成卡顿感；结果只弹 toast
  $('#muteModal').classList.remove('show');
  try {
    const r = await API('/api/mute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conv_id: currentConv, member_openid: ctxTargetMsg.sender_openid, seconds: total }),
    });
    if (r && r.ok) appendMuteBubble(memberName, durationText, memberOid);  // 气泡即提示，不弹 toast
    else showToast('禁言失败：' + ((r && r.error) || '未知错误'));
  } catch (err) {
    showToast('禁言失败：' + err);
  }
});

$('#btnCancelMute').addEventListener('click', () => $('#muteModal').classList.remove('show'));
$('#muteModal').addEventListener('click', (e) => { if (e.target === $('#muteModal')) $('#muteModal').classList.remove('show'); });
