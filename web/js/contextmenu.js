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
  // 撤回仅限自己发的、且发出不超过 2 分钟的消息（QQ 撤回时限）
  const recallOk = ctxTargetMsg.direction === 'outgoing'
    && (() => {
      const ts = ctxTargetMsg.timestamp;
      if (!ts) return false;
      const t = new Date(ts.replace(' ', 'T')).getTime();
      return !isNaN(t) && Date.now() - t <= 2 * 60 * 1000;
    })();
  $('#ctxRecall').style.display = recallOk ? '' : 'none';
  $('#ctxMultiSelect').style.display = '';
  $convCtxMenu.style.display = 'none';
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
    // 不在这里清空 ctxTargetMsg，让转发/收藏弹窗还能用到
    // 弹窗关闭时各自负责清理
  }
});

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
    if (currentConv === ctxConvId) {
      currentConv = '';
      $chatEmpty.style.display = 'flex';
      $messages.style.display = 'none';
      $chatHeader.style.display = 'none';
      $inputArea.style.display = 'none';
      $msgInput.disabled = true;
    }
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
  if (currentConv === ctxConvId) {
    currentConv = '';
    $chatEmpty.style.display = 'flex';
    $messages.style.display = 'none';
    $chatHeader.style.display = 'none';
    $inputArea.style.display = 'none';
    $msgInput.disabled = true;
  }
  renderConvList($searchInput.value);
  showToast('✓ 已删除聊天');
});

// ── 收藏 ─────────────────────────────────────────────
function getFavorites() {
  try { return JSON.parse(localStorage.getItem('neonbot_fav') || '[]'); }
  catch { return []; }
}
function saveFavorites(favs) { localStorage.setItem('neonbot_fav', JSON.stringify(favs)); }

function renderFavList() {
  const favs = getFavorites();
  const $favList = $('#favList');
  if (favs.length === 0) {
    $favList.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:20px;">暂无收藏</div>';
    return;
  }
  $favList.innerHTML = [...favs].reverse().map((f, i) => `
    <div style="padding:8px;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;gap:8px;">
      ${f.avatar ? `<img src="${escHtml(f.avatar)}" style="width:32px;height:32px;border-radius:50%;flex-shrink:0;margin-top:2px;" onerror="this.style.display='none'">` : ''}
      <div style="min-width:0;flex:1;">
        <div style="font-size:0.75em;color:var(--text-dim);">${escHtml(f.sender || '未知')}${roleBadge(f.member_role)} · ${escHtml(f.time || '')}</div>
        ${(f.imgUrls || []).map(u => `<a href="${escHtml(u)}" target="_blank"><img src="${escHtml(u)}" style="max-width:100%;max-height:300px;border-radius:6px;display:block;margin:4px 0;cursor:pointer;" onerror="this.style.display='none'"></a>`).join('')}
        ${(f.videoUrls || []).map(u => `<video src="${escHtml(u)}" controls preload="metadata" style="max-width:100%;max-height:300px;border-radius:6px;display:block;margin:4px 0;" onerror="this.style.display='none'"></video>`).join('')}
        ${(f.audioUrls || []).map(u => `<audio src="${escHtml(u)}" controls preload="metadata" style="display:block;margin:4px 0;width:100%;min-width:200px;" onerror="this.style.display='none'"></audio>`).join('')}
        ${(f.asrTexts || []).map(t => `<div class="asr-text">${escHtml(t)}</div>`).join('')}
        ${f.content && !['[图片]','[视频]','[语音]'].includes(f.content) ? `<div style="font-size:0.9em;word-break:break-word;">${escHtmlWithBr(f.content)}</div>` : (!f.imgUrls && !f.videoUrls && !f.audioUrls ? `<div style="font-size:0.9em;color:var(--text-dim);font-style:italic;">${escHtml(f.content || '[消息]')}</div>` : '')}
      </div>
      <button style="background:none;border:none;color:var(--danger);cursor:pointer;flex-shrink:0;" onclick="removeFav(${i})" title="取消收藏">✕</button>
    </div>
  `).join('');
}

function addFavorite(msg) {
  const favs = getFavorites();
  favs.push({
    content: msg.content || '',
    imgUrls: msg.imgUrls || [],
    videoUrls: msg.videoUrls || [],
    audioUrls: msg.audioUrls || [],
    asrTexts: msg.asrTexts || [],
    sender: msg.sender_name || '',
    avatar: msg.sender_avatar || '',
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
    .map(c => `<option value="${escHtml(c.id)}"${c.id === currentConv ? ' selected' : ''}>${escHtml(c.name || c.id)}</option>`)
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

