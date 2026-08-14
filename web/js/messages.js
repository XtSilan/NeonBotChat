// ── 追加单条消息 ────────────────────────────────────
// ── 日期分隔条 ──────────────────────────────────────
let lastMsgDate = null;

function fmtDateDivider(ts) {
  const d = ts.slice(0, 10);
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (d === ymd) return '今天';
  const yest = new Date(Date.now() - 86400000);
  const yestStr = `${yest.getFullYear()}-${String(yest.getMonth() + 1).padStart(2, '0')}-${String(yest.getDate()).padStart(2, '0')}`;
  if (d === yestStr) return '昨天';
  const [, m, day] = d.split('-');
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(d + 'T00:00:00').getDay()];
  return `${parseInt(m)}月${parseInt(day)}日 ${wd}`;
}

// ── 消息右键绑定：只在气泡/媒体内容区触发 ─────────
// （空白区交给聊天区的「清屏」菜单，避免整行隐形右键区）
function bindMsgContextMenu(el) {
  el.addEventListener('contextmenu', (e) => {
    const contentEl = e.target.closest ? e.target.closest('.msg-bubble, .img-placeholder, .msg-audio, .file-card') : null;
    if (!contentEl) return;
    onMsgContextMenu.call(el, e);
  });
}

// ── 内容渲染（Markdown / 纯文本 + 可选链接卡片）────
// 链接卡片开关在 设置 → 账号与安全（默认开启；关闭可提高安全性避免 IP 泄露）
function renderContentHtml(content, msgType) {
  if (msgType == 2) return renderMarkdown(content);
  const html = escHtmlWithBr(content);
  if (localStorage.getItem('link_cards') === '0') return html;
  return html.replace(/(https?:\/\/[^\s<]+)/g, (url) => {
    try { new URL(url); } catch (e) { return url; }
    const shortUrl = url.length > 70 ? url.slice(0, 70) + '…' : url;
    // 卡片上方独立一行显示原链接文字（带下划线）
    return `<a class="lc-ext" href="${url}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${escHtml(shortUrl)}</a><a class="link-card" href="${url}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" data-url="${url}">
      <div class="lc-body">
        <div class="lc-title">正在解析…</div>
      </div>
    </a>`;
  });
}

// 异步预加载链接卡片：抓取网页标题/描述/图标填充
function preloadLinkCards() {
  document.querySelectorAll('.link-card:not([data-preview])').forEach(el => {
    el.dataset.preview = 'loading';
    const url = el.dataset.url || '';
    if (!url) return;
    API(`/api/link-preview?url=${encodeURIComponent(url)}`).then(r => {
      if (!r || !r.ok || !r.title) { el.dataset.preview = 'done'; return; }  // 失败保留原链接文字
      el.innerHTML = `
        <div class="lc-body">
          <div class="lc-title">${escHtml(r.title)}</div>
          ${r.description ? `<div class="lc-desc">${escHtml(r.description)}</div>` : ''}
        </div>
        ${r.icon && r.icon.startsWith('http') ? `<img class="lc-icon" src="${escHtml(r.icon)}" onerror="this.remove()" alt="">` : ''}`;
      el.classList.add('loaded');
      el.dataset.preview = 'done';
    }).catch(() => { el.dataset.preview = 'done'; });
  });
}

// ── 卡片消息（msg_type=8）渲染 ─────────────────────
function parseCardMessage(content) {
  if (!content || typeof content !== 'string') return null;
  try {
    const obj = JSON.parse(content);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch (e) {}
  return null;
}

// 标题/描述/图片 + 末尾分割线 + 下划线链接
function renderCardMessageHtml(content) {
  const card = parseCardMessage(content);
  if (!card) return '';
  // 兼容两种结构：扁平 {title,desc,pic_url,url} 或 tuwen {"type":"tuwen","content":{...}}
  const data = (card.content && typeof card.content === 'object' && !Array.isArray(card.content)) ? card.content : card;
  const title = data.title || data.desc || data.description || '卡片消息';
  const desc = data.desc || data.description || '';
  const pic = data.pic_url || data.picture || '';
  const url = data.url || '';
  return `
    <div class="card-msg">
      <div class="card-msg-main">
        <div class="card-msg-text">
          <div class="card-msg-title">${escHtml(title)}</div>
          ${desc ? `<div class="card-msg-desc">${escHtmlWithBr(desc)}</div>` : ''}
        </div>
        ${pic ? `<img class="card-msg-pic" src="${escHtml(pic)}" onerror="this.remove()" alt="">` : ''}
      </div>
      ${url ? `<div class="card-msg-sep"></div><a class="card-msg-link" href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${escHtml(url.length > 70 ? url.slice(0, 70) + '…' : url)}</a>` : ''}
    </div>`;
}

// ── 群聊的聊天记录（合并转发）─────────────────────
let chatRecordCache = [];

// 转发消息文本里的富媒体附件（QQ 转发渲染格式：`[附件N] 类型:图片 文件名:... 尺寸:... 大小:... URL:...`）
// 注意：纯富媒体转发消息没有 [消息内容] 行，只有 [发送者] + [附件N] 行
function parseForwardAttachments(text) {
  const out = [];
  const re = /\[附件\d+\]\s*类型:(\S+)\s+文件名:([^\s]+)\s+尺寸:(\S+)\s+大小:(\S+)\s+URL:(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const type = { '图片': 'image', '视频': 'video', '语音': 'audio', '文件': 'file' }[m[1]] || 'file';
    out.push({ type, filename: m[2], size: m[3], url: m[5] });
  }
  return out;
}

function parseChatRecord(content) {
  if (!content || !content.startsWith('[群聊的聊天记录]')) return null;
  const msgs = [];
  const blocks = content.split(/=== 消息 \d+ ===/);
  for (const b of blocks) {
    // QQ 转发格式有空格变体：[发 送者]、[ 消息内容]
    const senderM = b.match(/\[发\s*送者\]\s*([^\n]+)/);
    if (!senderM) continue;
    const sender = senderM[1].trim();
    const contentM = b.match(/\[ *消息内容 *\]\s*([\s\S]*?)(?=\n\[附件\d+\]|\n\[发\s*送者\]|$)/);
    const text = contentM ? contentM[1].trim() : '';
    const atts = parseForwardAttachments(b);
    const media = atts.filter(a => a.type === 'image' || a.type === 'video')
      .map(a => ({ url: a.url, type: a.type }));
    // 只有附件没有文本的消息：补占位文字（仅 [媒体类型]，文件名不展示；真实媒体由展开详情渲染）
    const mediaOnly = !text && atts.length > 0;  // 纯媒体消息（无文本）：展开时不垫气泡、不显示占位文字
    let displayText = text;
    if (mediaOnly) {
      const label = { 'image': '[图片]', 'video': '[视频]', 'audio': '[语音]', 'file': '[文件]' }[atts[0].type] || '[文件]';
      displayText = atts.length > 1 ? `${label} ×${atts.length}` : label;
    }
    msgs.push({ content: displayText, sender, media, mediaOnly });
  }
  return msgs.length ? msgs : null;
}

function forwardMediaHtml(media, cls) {
  if (!media || !media.length) return '';
  return media.slice(0, 3).map(x => {
    const src = isFileServerUrl(x.url) ? x.url : `/api/image?url=${encodeURIComponent(x.url)}`;
    return x.type === 'image'
      ? `<img src="${escHtml(src)}" class="${cls}" alt="">`
      : `<video src="${escHtml(src)}" class="${cls}" muted></video>`;
  }).join('');
}

function renderChatRecordCard(msgs) {
  chatRecordCache = msgs;
  // 前 4 条预览：`发送者: 内容` 全灰色，单条最多 20 字符；富媒体仅显示 [媒体类型]，不渲染
  const preview = msgs.slice(0, 4).map(m => {
    const line = `${m.sender}: ${m.content}`;
    const short = line.length > 20 ? line.slice(0, 20) + '...' : line;
    return `<div class="cr-line">${escHtml(short)}</div>`;
  }).join('');
  return `
    <div class="chat-record" onclick="openChatRecord()">
      <div class="cr-head"><img src="icons/documents.svg" class="svg-icon" style="width:14px;height:14px;" alt=""> 群聊的聊天记录</div>
      ${preview}
      <div class="cr-more">查看${msgs.length}条转发消息 ›</div>
    </div>`;
}

// 展开全部：气泡形式（无头像，统一左侧灰色，显示发送者昵称）
// 纯媒体消息（mediaOnly）：不显示 [媒体类型] 占位、不垫气泡底，直接渲染真实媒体；图文混排/纯文本保留气泡
function openChatRecord() {
  if (!chatRecordCache.length) return;
  $('#chatRecordList').innerHTML = chatRecordCache.map(m =>
    m.mediaOnly
      ? `<div class="cr-bubble-row in">
          <div class="cr-sender-name">${fmtBotMarker(escHtml(m.sender))}</div>
          <div class="cr-media-raw">${forwardMediaHtml(m.media, 'cr-bubble-media')}</div>
        </div>`
      : `<div class="cr-bubble-row in">
          <div class="cr-sender-name">${fmtBotMarker(escHtml(m.sender))}</div>
          <div class="cr-bubble in">${escHtmlWithBr(m.content)}${forwardMediaHtml(m.media, 'cr-bubble-media')}</div>
        </div>`
  ).join('');
  $('#chatRecordModal').classList.add('show');
}
$('#btnCloseChatRecord').addEventListener('click', () => $('#chatRecordModal').classList.remove('show'));
$('#chatRecordModal').addEventListener('click', (e) => {
  if (e.target === $('#chatRecordModal')) $('#chatRecordModal').classList.remove('show');
});

// 私聊（direct）：不显示发送者昵称与头像列（单聊双方已知）
function isDirectConv(msgConvType) {
  return msgConvType === 'direct' || currentConvType === 'direct';
}

// ── 消息头像列（气泡外）───────────────────────────
function msgAvatarHtml(direction, senderAvatar, senderName) {
  if (direction === 'outgoing') {
    // 自己发的：用自己设置的头像，未设置则不显示头像列（点击弹成员卡片，由 $messages 统一处理）
    return getBotAvatar()
      ? `<div class="msg-avatar-col"><img src="${escHtml(getBotAvatar())}" class="msg-avatar-img" onerror="this.style.display='none'" alt=""></div>`
      : '';
  }
  if (senderAvatar) {
    return `<div class="msg-avatar-col"><img src="${escHtml(senderAvatar)}" class="msg-avatar-img" onerror="this.style.display='none'" alt=""></div>`;
  }
  // 私聊：用会话头像（单聊即对方头像）
  if (direction !== 'outgoing' && currentConvType === 'direct') {
    const conv = findConvAnywhere(currentConv);
    const convAv = conv && conv.avatar_url;
    if (convAv) {
      return `<div class="msg-avatar-col"><img src="${escHtml(convAv)}" class="msg-avatar-img" onerror="this.style.display='none'" alt=""></div>`;
    }
  }
  // 无头像：首字符占位
  return `<div class="msg-avatar-col"><span class="msg-avatar-fallback">${escHtml((senderName || '?')[0])}</span></div>`;
}

// ── 消息元信息行（气泡外：昵称 + 群角色）──────────
function msgMetaHtml(direction, senderName, memberRole) {
  if (!senderName) return '';
  const roleCls = memberRole ? ' role-' + memberRole : '';
  if (direction === 'outgoing') {
    // 机器人自己发的消息：身份取自群信息缓存（bot_state），徽章放在机器人标识前
    const conv = findConvAnywhere(currentConv);
    const role = memberRole || (conv && conv.bot_role) || '';
    const cls = role ? ' role-' + role : '';
    return `<div class="msg-meta meta-self${cls}"><span class="bot-role-badge">${roleBadge(role)}</span>${icon('bot', 14)} ${escHtml(senderName.replace(/ 🤖$/, ''))}</div>`;
  }
  return `<div class="msg-meta${roleCls}">${fmtBotMarker(escHtml(senderName))}${roleBadge(memberRole)}</div>`;
}

function appendMessage(msg, scroll) {
  // 日期分隔条：与上一条消息日期不同时插入
  if (msg.timestamp) {
    const day = msg.timestamp.slice(0, 10);
    if (day !== lastMsgDate) {
      lastMsgDate = day;
      const sep = document.createElement('div');
      sep.className = 'msg-date-divider';
      sep.textContent = fmtDateDivider(msg.timestamp);
      $messages.appendChild(sep);
    }
  }
  const div = document.createElement('div');
  div.className = `msg-row ${msg.direction === 'outgoing' ? 'out' : 'in'}`;
  div.dataset.msgId = msg.id || '';
  div.dataset.msgDirection = msg.direction || '';
  div.dataset.msgContent = msg.content || '';
  div.dataset.msgSender = msg.sender_name || '';
  div.dataset.msgSenderAvatar = msg.sender_avatar || '';
  div.dataset.msgTimestamp = msg.timestamp || '';
  div.dataset.msgMemberRole = msg.member_role || '';
  div.dataset.msgSenderOpenid = msg.sender_openid || '';
  div.dataset.msgType = msg.msg_type || 0;
  div.dataset.msgRefIdx = msg.ref_idx || '';
  div.dataset.msgQuotedRefIdx = msg.quoted_ref_idx || '';
  bindMsgContextMenu(div);

  // 解析附件
  let attachHtml = '';
  try {
    const attachments = typeof msg.attachments === 'string' ? JSON.parse(msg.attachments) : (msg.attachments || []);
    for (const a of attachments) {
      // 语音用 voice_wav_url，其他用 url
      const rawUrl = a.content_type === 'voice' ? (a.voice_wav_url || a.url) : a.url;
      if (rawUrl) {
        // 图床 / 语音直接用原始 URL，QQ CDN 走代理
        const isDirect = a.content_type === 'voice' || (a.content_type && a.content_type.startsWith('audio/')) || isFileServerUrl(rawUrl);
        const mediaUrl = isDirect ? rawUrl : `/api/image?url=${encodeURIComponent(rawUrl)}`;
        const isVoice = a.content_type === 'voice' || (a.content_type && a.content_type.startsWith('audio/'));
        if (a.content_type && a.content_type.startsWith('image/')) {
          const isSticker = msg.content === '[表情]';
          const maxW = isSticker ? 120 : 280;
          const maxH = isSticker ? 120 : 280;
          let w, h, hasSize = a.width && a.height;
          if (hasSize) {
            w = Math.min(a.width, maxW);
            h = Math.round(w * a.height / a.width);
            if (h > maxH) { h = maxH; w = Math.round(h * a.width / a.height); }
          }
          const sizeStyle = hasSize ? `width:${w}px;height:${h}px;` : `max-width:${maxW}px;max-height:${maxH}px;`;
          const placeStyle = hasSize ? `width:${w}px;height:${h}px;` : '';
          attachHtml += `<div class="img-placeholder" style="${placeStyle}"><img src="${escHtml(mediaUrl)}" class="msg-image${isSticker ? ' sticker-img' : ''}" alt="${escHtml(a.filename || '图片')}" onclick="viewMedia(event)" onerror="this.closest('.img-placeholder').outerHTML='<div class=\\'media-expired\\'>图片已过期</div>';" onload="this.style.opacity='1'" style="${sizeStyle}opacity:0;"></div>`;
        } else if (a.content_type && a.content_type.startsWith('video/')) {
          const maxVW = 280, maxVH = 280;
          let vw, vh, hasSize = a.width && a.height;
          if (hasSize) {
            vw = Math.min(a.width, maxVW);
            vh = Math.round(vw * a.height / a.width);
            if (vh > maxVH) { vh = maxVH; vw = Math.round(vh * a.width / a.height); }
          }
          const sizeStyle = hasSize ? `width:${vw}px;height:${vh}px;` : `max-width:${maxVW}px;max-height:${maxVH}px;`;
          const placeStyle = hasSize ? `width:${vw}px;height:${vh}px;` : '';
          attachHtml += `<div class="img-placeholder" style="${placeStyle};cursor:pointer;" title="点击全屏播放" onclick="viewMedia(event)"><div class="video-play-btn"></div><video src="${escHtml(mediaUrl)}" class="msg-video" muted playsinline preload="metadata" style="${sizeStyle}border-radius:8px;display:block;position:relative;z-index:2;pointer-events:none;opacity:0;" onloadedmetadata="this.style.opacity='1'" onerror="this.closest('.img-placeholder').outerHTML='<div class=\\'media-expired\\'>视频已过期</div>';" oncontextmenu="event.stopPropagation()"></video></div>`;
        } else if (isVoice || (a.content_type && a.content_type.startsWith('audio/'))) {
          attachHtml += `<audio src="${escHtml(mediaUrl)}" class="msg-audio" controls preload="auto" style="display:block;margin-bottom:2px;max-width:280px;position:relative;z-index:2;pointer-events:auto;" onerror="this.outerHTML='<div class=\\'media-expired\\'>语音已过期</div>';" oncontextmenu="event.stopPropagation()"></audio>`;
          if (a.asr_refer_text) { attachHtml += `<div class="asr-text">${escHtmlWithBr(a.asr_refer_text)}</div>`; }
        } else if (a.content_type === 'file') {
          const sizeStr = formatFileSize(a.size || 0);
          attachHtml += `<div class="file-card" onclick="downloadFile('${escHtml(rawUrl)}', '${escHtml(a.filename || 'file')}', this)" title="点击下载">
            <span class="file-icon"><img src="icons/${fileIconName(a.filename || '')}.svg" class="svg-icon" style="width:20px;height:20px;" alt=""></span>
            <div class="file-info">
              <div class="file-name">${escHtml(a.filename || '未知文件')}</div>
              <div class="file-size">${sizeStr}</div>
            </div>
          </div>`;
        }
      }
    }
  } catch (e) {}

  // 本地系统提示（禁言/解除禁言）：居中气泡，成员名蓝色
  if (msg.direction === 'center') {
    div.classList.remove('in', 'out');
    div.classList.add('center');
    div.innerHTML = `<div class="msg-bubble"><span class="mute-member-name">${escHtml(msg.sender_name || '')}</span>${escHtml(msg.content)}</div>`;
    $messages.appendChild(div);
    if (scroll) autoScrollMsg(msg);
    return;
  }

  // 撤回消息特殊渲染
  if (msg.recalled) {
    div.classList.remove('in', 'out');
    div.classList.add('center');
    // 撤回自己的消息显示「你撤回了一条消息」+ 重新编辑；撤回别人的显示「你撤回了成员 XXX 的一条消息」
    const isOwn = msg.direction === 'outgoing';
    const noReedit = !isOwn || ['[图片]','[视频]','[语音]','[文件]','[卡片消息]','[键盘]'].some(p => (msg.content || '').startsWith(p)) || (msg.msg_type == 8);
    const recallTip = isOwn ? '你撤回了一条消息'
      : `你撤回了成员<span class="mute-member-name">${escHtml(msg.sender_name || '')}</span>的一条消息`;
    div.innerHTML = `<div class="msg-bubble">${recallTip}${noReedit ? '' : ` <span class="reedit-link" onclick="reeditMessageContent('${encodeURIComponent(msg.content || '')}', ${msg.msg_type || 0}, '${msg.quoted_ref_idx || ''}', '${(msg.quoted_sender || '').replace(/'/g, "\\'")}', '${(msg.quoted_content || '').replace(/'/g, "\\'")}')">重新编辑</span>`}</div>`;
    $messages.appendChild(div);
    if (scroll) autoScrollMsg(msg);
    return;
  }

  const placeholders = ['[富媒体文件]', '[图片]', '[视频]', '[语音]', '[文件]', '[表情]', '[卡片消息]', '[键盘]', '[自定义消息]'];
  const isPlaceholder = !attachHtml && placeholders.includes(msg.content);
  // 纯媒体消息（图片/视频/语音，无文本无引用）不垫气泡底
  const mediaOnly = attachHtml && !msg.quoted_content && (
    !msg.content || ['[图片]', '[视频]', '[语音]', '[富媒体文件]'].includes(msg.content)
  );
  // 群聊的聊天记录（合并转发）→ 卡片
  const chatRecord = parseChatRecord(msg.content);
  const chatRecordHtml = chatRecord ? renderChatRecordCard(chatRecord) : '';

  const noMeta = isDirectConv(msg.conv_type);  // 私聊不显示昵称（头像保留）
  div.innerHTML = `
    <div class="msg-checkbox"><img src="icons/ok.svg" class="svg-icon" style="width:12px;height:12px;" alt=""></div>
    ${msgAvatarHtml(msg.direction, msg.sender_avatar, msg.sender_name)}
    <div class="msg-body">
      ${noMeta ? '' : msgMetaHtml(msg.direction, msg.sender_name, msg.member_role)}
      <div class="msg-bubble${mediaOnly ? ' media-only' : ''}">
        ${msg.quoted_ref_idx ? `<div class="quote-box" onclick="scrollToQuoted('${msg.quoted_ref_idx || ''}')" title="点击跳转到原消息"><div class="quote-sender"><span>${msg.quoted_content ? fmtBotMarker(escHtml(msg.quoted_sender || '未知用户')) : '引用了一条消息'}</span><img src="icons/up.svg" class="svg-icon" style="width:12px;height:12px;margin-left:4px;opacity:0.5;" alt=""></div>${msg.quoted_content ? `<div class="quote-content">${fmtQuoteContent(msg.quoted_content, msg.quote_thumbs)}</div>` : ''}</div>` : ''}
        ${attachHtml}
        ${chatRecordHtml || (msg.msg_type == 8 ? (renderCardMessageHtml(msg.content) || `<div class="media-placeholder">${escHtmlWithBr(msg.content)}</div>`) : (msg.content && !placeholders.includes(msg.content) && !msg.content.startsWith('[文件]') ? `<div class="${isPlaceholder ? 'media-placeholder' : ''}">${renderContentHtml(msg.content, msg.msg_type)}</div>` : (isPlaceholder ? `<div class="media-placeholder">${escHtmlWithBr(msg.content)}</div>` : '')))}
      </div>
    </div>
  `;

  // 时间放在气泡内部（绝对定位到气泡外）
  const timeExt = document.createElement('div');
  timeExt.className = 'msg-time-ext';
  timeExt.textContent = fmtTime(msg.timestamp);
  div.querySelector('.msg-bubble').appendChild(timeExt);

  $messages.appendChild(div);
  preloadLinkCards();  // 触发新消息中的链接卡片预加载
  if (scroll) autoScrollMsg(msg);
}

// 新消息到达：用户滚在底部附近才自动滚动到底；已向上翻阅则弹「↓ 跳转至最新消息」按钮，
// 点击后再跳（自己发出的消息强制滚到底，保证发送反馈可见）
function autoScrollMsg(msg) {
  if (msg.direction === 'outgoing') { scrollBottom(); hideJumpBtn(); return; }
  const atBottom = $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight < 80;
  if (atBottom) scrollBottom();
  else showJumpBtn();
}

// ── 「跳至最新消息」悬浮按钮 ─────────────────────────
let jumpNewCount = 0;
function showJumpBtn() {
  const btn = $('#jumpNewBtn');
  if (!btn) return;
  jumpNewCount++;
  btn.textContent = `↓ 跳转至最新消息(${jumpNewCount}条)`;
  btn.style.display = 'block';  // 先显示，定位时才能取到实际宽度
  updateJumpBtnPos();
}
function hideJumpBtn() {
  const btn = $('#jumpNewBtn');
  if (btn) btn.style.display = 'none';
  jumpNewCount = 0;
}
// 按钮悬浮在消息区底部、输入框正上方居中（absolute 相对 chatArea，坐标按输入框实时位置计算）
function updateJumpBtnPos() {
  const btn = $('#jumpNewBtn');
  if (!btn || btn.style.display === 'none') return;
  const ca = document.getElementById('chatArea');
  const ia = document.getElementById('inputArea');
  if (!ca || !ia) return;
  const caR = ca.getBoundingClientRect(), iaR = ia.getBoundingClientRect();
  const w = btn.offsetWidth || 160;  // 按钮实际宽度，按自身宽度精确居中
  btn.style.left = ((iaR.left + iaR.width / 2 - caR.left) - w / 2) + 'px';  // 水平居中于输入框
  btn.style.bottom = (caR.bottom - iaR.top + 12) + 'px';  // 贴输入框顶上方
}
$('#jumpNewBtn').addEventListener('click', () => { scrollBottom(); hideJumpBtn(); });
// 用户滚回底部附近：按钮自动消失
$messages.addEventListener('scroll', () => {
  const btn = $('#jumpNewBtn');
  if (!btn || btn.style.display === 'none') return;
  if ($messages.scrollHeight - $messages.scrollTop - $messages.clientHeight < 80) hideJumpBtn();
});
window.addEventListener('resize', updateJumpBtnPos);

// 点击查看大图
// ── 发送消息 ────────────────────────────────────────
let pendingId = 0;
let currentQuoteRef = null;  // 当前引用的消息 ref_idx
let botDisplayName = '';  // Bot 自己的显示名称

// 发送前检查：用进群时实时检查到的权限状态（conv.proactive_msg），不做额外网络请求
// 返回 true 表示可以继续发送（非群聊 / 有权限 / 用户确认）；convId 可指定目标会话（转发用）
async function ensureProactiveAllowed(convId) {
  const conv = findConvAnywhere(convId || currentConv);
  if (!conv || conv.type !== 'group') return true;
  if (conv.proactive_msg === 1) return true;
  return await showConfirm('当前群聊本机器人未被授予主动消息权限，是否确认继续发送？', 'warning', false, true);
}

async function sendMessage(retryMsgId) {
  const isRetry = !!retryMsgId;
  let content;
  let retryEl = null;
  if (isRetry) {
    // 重发：从 data 属性取内容
    retryEl = document.querySelector(`.msg-row[data-pending-id="${retryMsgId}"]`);
    if (!retryEl) return;
    content = retryEl.dataset.msgContent;
  } else {
    content = $msgInput.value.trim();
    if (!content || !currentConv) return;
  }

  // 无主动消息权限的群：发送任何消息前先弹确认（取消则保留重发气泡）
  if (!(await ensureProactiveAllowed())) return;
  if (retryEl) retryEl.remove();

  // 检查是否发送为 markdown
  const msgType = $('#mdCheckbox').checked ? 2 : 0;
  const quoteRef = currentQuoteRef;
  currentQuoteRef = null;
  $('#inputQuoteBar').style.display = 'none';

  const tempId = isRetry ? retryMsgId : `pending_${++pendingId}`;

  // 立即在 UI 显示气泡
  const fakeMsg = {
    id: 0,
    pending_id: tempId,
    conversation_id: currentConv,
    sender_name: botDisplayName || 'Bot',
    content: content,
    direction: 'outgoing',
    msg_type: msgType,
    timestamp: new Date().toISOString(),
    sender_avatar: '',
    quoted_sender: quoteRef ? (quoteRef.quoted_sender || '') : '',
    quoted_content: quoteRef ? (quoteRef.quoted_content || '') : '',
    quoted_ref_idx: quoteRef ? (quoteRef.message_id || '') : '',
    quote_thumbs: quoteRef ? (quoteRef.thumbs || []) : [],
  };
  appendPendingMessage(fakeMsg);
  if (!isRetry) {
    $msgInput.value = '';
    $msgInput.style.height = 'auto';
    $('#mdCheckbox').checked = false;
    updateMdToggle();
  }

  pendingContents.add(content);
  $sendBtn.disabled = true;

  try {
    const result = await API('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conv_id: currentConv, content, msg_type: msgType, message_reference: quoteRef ? { message_id: quoteRef.message_id } : undefined, quote_thumbs: quoteRef ? JSON.stringify(quoteRef.thumbs || []) : '' }),
    });
    if (result.error) {
      markMessageFailed(tempId);
    } else {
      replacePendingMessage(tempId, result.message);
    }
  } catch (e) {
    markMessageFailed(tempId);
  } finally {
    pendingContents.delete(content);
    $sendBtn.disabled = false;
    $msgInput.disabled = false;
    if (!isRetry) $msgInput.focus();
  }
}

function appendPendingMessage(msg) {
  const div = document.createElement('div');
  div.className = 'msg-row out pending';
  div.dataset.pendingId = msg.pending_id;
  div.dataset.msgContent = msg.content;

  div.innerHTML = `
    ${msgAvatarHtml('outgoing', '', msg.sender_name)}
    <div class="msg-body">
      ${isDirectConv() ? '' : msgMetaHtml('outgoing', msg.sender_name, '')}
      <div style="display:flex;align-items:center;gap:8px;flex-direction:row-reverse;">
        <div class="msg-bubble">
          ${msg.quoted_content ? `<div class="quote-box" onclick="scrollToQuoted('${msg.quoted_ref_idx || ''}')" title="点击跳转到原消息"><div class="quote-sender"><span>${fmtBotMarker(escHtml(msg.quoted_sender || '未知用户'))}</span><img src="icons/up.svg" class="svg-icon" style="width:12px;height:12px;margin-left:4px;opacity:0.5;" alt=""></div><div class="quote-content">${fmtQuoteContent(msg.quoted_content, msg.quote_thumbs)}</div></div>` : ''}
          <div>${msg.msg_type == 8 ? (renderCardMessageHtml(msg.content) || escHtmlWithBr(msg.content)) : renderContentHtml(msg.content, msg.msg_type)}</div>
        </div>
        <button class="msg-retry" onclick="sendMessage('${msg.pending_id}')" title="重发">!</button>
      </div>
    </div>
  `;
  const timeExt = document.createElement('div');
  timeExt.className = 'msg-time-ext';
  timeExt.style.opacity = '1';
  timeExt.textContent = '发送中…';
  div.querySelector('.msg-bubble').appendChild(timeExt);

  bindMsgContextMenu(div);
  $messages.appendChild(div);
  preloadLinkCards();  // 发送中的消息也预加载链接卡片
  scrollBottom();
}

function replacePendingMessage(pendingId, realMsg) {
  const el = document.querySelector(`.msg-row[data-pending-id="${pendingId}"]`);
  if (!el) return;
  // 用真实消息替换
  el.classList.remove('pending');
  el.dataset.msgId = realMsg.id || '';
  el.dataset.msgDirection = 'outgoing';
  el.dataset.msgContent = realMsg.content || '';
  el.dataset.msgSender = realMsg.sender_name || '';
  el.dataset.msgSenderAvatar = realMsg.sender_avatar || '';
  el.dataset.msgTimestamp = realMsg.timestamp || '';
  el.dataset.msgMemberRole = realMsg.member_role || '';
  el.dataset.msgSenderOpenid = realMsg.sender_openid || '';
  el.dataset.msgType = realMsg.msg_type || 0;
  el.dataset.msgRefIdx = realMsg.ref_idx || '';
  el.removeAttribute('data-pending-id');
  const oldQuoteBox = el.querySelector('.quote-box');
  const oldQuoteHTML = oldQuoteBox ? oldQuoteBox.outerHTML : '';

  el.innerHTML = `
    ${msgAvatarHtml('outgoing', '', realMsg.sender_name)}
    <div class="msg-body">
      ${isDirectConv() ? '' : msgMetaHtml('outgoing', realMsg.sender_name, realMsg.member_role)}
      <div class="msg-bubble">
        ${realMsg.quoted_content ? `<div class="quote-box"><div class="quote-sender">${fmtBotMarker(escHtml(realMsg.quoted_sender || '未知用户'))}</div><div class="quote-content">${fmtQuoteContent(realMsg.quoted_content, realMsg.quote_thumbs)}</div></div>` : ''}
        <div>${realMsg.msg_type == 8 ? (renderCardMessageHtml(realMsg.content) || escHtmlWithBr(realMsg.content)) : renderContentHtml(realMsg.content, realMsg.msg_type)}</div>
      </div>
    </div>
  `;
  preloadLinkCards();  // 发送成功替换后预加载链接卡片
  let timeExt = el.querySelector('.msg-time-ext');
  if (!timeExt) { timeExt = document.createElement('div'); timeExt.className = 'msg-time-ext'; el.querySelector('.msg-bubble').appendChild(timeExt); }
  timeExt.textContent = fmtTime(realMsg.timestamp);

  // 更新 lastMsgId
  if (realMsg.id) lastMsgId = Math.max(lastMsgId, realMsg.id);
  // 恢复引用框缩略图（服务器不存 thumb URL）
  if (oldQuoteHTML) {
    const newQuote = el.querySelector('.quote-box');
    if (newQuote) newQuote.outerHTML = oldQuoteHTML;
  }
}

function markMessageFailed(pendingId) {
  const el = document.querySelector(`.msg-row[data-pending-id="${pendingId}"]`);
  if (!el) return;
  el.classList.remove('pending');
  el.classList.add('failed');
  // 失败只显示红色感叹号，不显示错误文字
  const timeEl = el.querySelector('.msg-time-ext');
  if (timeEl) timeEl.remove();
}

// ── 事件绑定 ────────────────────────────────────────
$sendBtn.addEventListener('click', () => sendMessage());
$msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
// 自动调整输入框高度
$msgInput.addEventListener('input', () => {
  $msgInput.style.height = 'auto';
  $msgInput.style.height = Math.min($msgInput.scrollHeight, 120) + 'px';
  updateJumpBtnPos();  // 输入框变高时按钮跟着上移
});
// ── @提及：输入 @ 弹出成员列表，继续打字检索；无匹配自动消失；点击纯文本填充 ──
function collectConvUsers() {
  const users = new Map();  // openid → {name, avatar}
  document.querySelectorAll('#messages .msg-row[data-msg-sender-openid]').forEach((row) => {
    const oid = row.dataset.msgSenderOpenid;
    const nm = row.dataset.msgSender;
    if (!oid || !nm || oid === 'self') return;  // 排除机器人自己
    if (!users.has(oid)) users.set(oid, { name: nm, avatar: row.dataset.msgSenderAvatar || '' });
  });
  return [...users.entries()].map(([openid, u]) => ({ openid, name: u.name, avatar: u.avatar }));
}
function updateMentionList() {
  const list = $('#mentionList');
  if (!list) return;
  if (currentConvType === 'direct') { list.style.display = 'none'; return; }  // 私聊不弹艾特面板
  const el = $msgInput;
  const selStart = el.selectionStart;
  const text = el.value;
  const atIdx = text.lastIndexOf('@', selStart - 1);
  // 光标前无 @，或 @ 与光标间有换行（多行输入）→ 关闭
  if (atIdx === -1 || text.slice(atIdx, selStart).includes('\n')) { list.style.display = 'none'; return; }
  const query = text.slice(atIdx + 1, selStart).trim();
  const users = collectConvUsers().filter(u => u.name.toLowerCase().includes(query.toLowerCase()));
  if (!users.length) { list.style.display = 'none'; return; }  // 无匹配 → 自动消失
  list.innerHTML = users.map(u => `
    <div class="mention-item" data-name="${escHtml(u.name)}">
      <div class="mi-avatar">${u.avatar ? `<img src="${escHtml(u.avatar)}" alt="">` : escHtml((u.name || '?')[0])}</div>
      <div class="mi-name">${escHtml(u.name)}</div>
    </div>`).join('');
  // 面板 absolute 定位跟随输入框（相对 #chatArea：脱离 input-area 的 backdrop root，
  // 毛玻璃可采样聊天区/背景层；absolute 不受 transform/backdrop-filter 包含块干扰）
  const caRect = document.getElementById('chatArea').getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  list.style.left = (rect.left - caRect.left) + 'px';
  list.style.bottom = (caRect.bottom - rect.top) + 'px';
  list.style.width = rect.width + 'px';
  list.style.display = 'block';
  // 用 mousedown + preventDefault：在输入框 blur 前执行，保持焦点
  list.querySelectorAll('.mention-item').forEach((item) => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const name = item.dataset.name;
      const pos = el.selectionStart;
      const t = el.value;
      const at = t.lastIndexOf('@', pos - 1);
      if (at === -1) return;
      el.value = t.slice(0, at + 1) + name + ' ' + t.slice(pos);  // @XX → @指定用户（末尾补空格，分隔后续文字）
      const np = at + 1 + name.length + 1;
      el.selectionStart = el.selectionEnd = np;
      el.focus();
      el.dispatchEvent(new Event('input'));  // 触发高度自动调整
      list.style.display = 'none';
    });
  });
}
$msgInput.addEventListener('input', updateMentionList);
$msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'Enter') {
    const list = $('#mentionList');
    if (list) list.style.display = 'none';
  }
});
$msgInput.addEventListener('blur', () => {
  const list = $('#mentionList');
  if (list) list.style.display = 'none';
});
// 窗口尺寸变化时若面板可见，重算 fixed 位置
window.addEventListener('resize', () => {
  const list = $('#mentionList');
  if (list && list.style.display !== 'none') updateMentionList();
});
// ── 富媒体上传 ────────────────────────────────────────
function toggleMD() {
  const cb = $('#mdCheckbox');
  cb.checked = !cb.checked;
  updateMdToggle();
  $('#richMenu').style.display = 'none';
}
function updateMdMenuStatus() {
  $('#mdMenuStatus').innerHTML = $('#mdCheckbox').checked ? '<img src="icons/ok.svg" class="svg-icon" style="width:12px;height:12px;vertical-align:-1px;" alt="">' : '';
}
function toggleExpandInput() {
  $('#richMenu').style.display = 'none';
  const ta = $('#msgInput');
  if (ta.style.maxHeight === 'none') {
    ta.style.maxHeight = '120px';
    ta.style.height = 'auto';
  } else {
    ta.style.maxHeight = 'none';
    ta.style.height = '200px';
  }
  ta.focus();
  updateExpandMenuStatus();
}
function updateExpandMenuStatus() {
  $('#expandMenuStatus').innerHTML = $('#msgInput').style.maxHeight === 'none' ? '<img src="icons/ok.svg" class="svg-icon" style="width:12px;height:12px;vertical-align:-1px;" alt="">' : '';
}
$('#richMediaBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#richMenu');
  const btn = $('#richMediaBtn');
  const rect = btn.getBoundingClientRect();
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  menu.style.left = Math.min(rect.left, window.innerWidth - 180) + 'px';
  menu.style.top = (rect.top - menu.offsetHeight - 6) + 'px';
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#richMenu') && !e.target.closest('#richMediaBtn')) {
    $('#richMenu').style.display = 'none';
  }
});

let richMediaType = 'image';
async function pickRichMedia(type) {
  $('#richMenu').style.display = 'none';
  if (type === 'file') {
    if (!(await showConfirm('当前 QQ API 不稳定，文件发送几乎 100% 失败，你确认要继续发送吗？', 'query', false))) return;
  }
  richMediaType = type;
  if (type === 'image') $('#richFileInput').accept = 'image/*';
  else if (type === 'video') $('#richFileInput').accept = 'video/*';
  else if (type === 'voice') $('#richFileInput').accept = 'audio/*';
  else if (type === 'file') $('#richFileInput').accept = '*/*';
  $('#richFileInput').click();
}

$('#richFileInput').addEventListener('change', async function() {
  const file = this.files[0];
  this.value = '';
  if (!file) return;
  if (!currentConv) { showToast('⚠ 请先选择一个群聊'); return; }
  await sendRichFile(file, richMediaType);
});

// ── 粘贴 / 拖拽文件发送（需确认）──────────────────
$msgInput.addEventListener('paste', async (e) => {
  const files = e.clipboardData && e.clipboardData.files;
  if (!files || !files.length) return;
  e.preventDefault();
  await confirmAndSendFile(files[0]);
});

async function confirmAndSendFile(file) {
  if (!currentConv) { showToast('⚠ 请先选择一个群聊'); return; }

  let type = null;
  let skipFileConfirm = false;  // 音频已选「作为文件」，不再二次确认
  if (file.type.startsWith('image/')) type = 'image';
  else if (file.type.startsWith('video/')) type = 'video';
  else if (file.type.startsWith('audio/')) {
    // 音频：一次弹窗确认以语音还是文件形式发送
    const choice = await showConfirm('以「语音」形式发送该音频？', 'audio', false, true, '作为文件');
    if (choice === true) type = 'voice';
    else if (choice === 'third') { type = 'file'; skipFileConfirm = true; }
    else return;
  } else {
    type = 'file';
  }

  // 确认弹窗：图片/视频预览 + 文件大小提示
  const previewUrl = URL.createObjectURL(file);
  const sizeHint = `（文件大小：${formatFileSize(file.size)}）`;
  const previewType = (type === 'image' || type === 'video') ? type : '';
  let confirmed;
  if (type === 'file' && !skipFileConfirm) {
    confirmed = await showConfirm(`当前 QQ API 不稳定，文件发送几乎 100% 失败，你确认要继续发送吗？${sizeHint}`, 'query', false, true, '', previewUrl, previewType);
  } else {
    const nameMap = { image: '图片', video: '视频', voice: '语音' };
    confirmed = await showConfirm(`以「${nameMap[type]}」形式发送粘贴的文件？${sizeHint}`, type, false, true, type === 'voice' ? '作为文件' : '', previewUrl, previewType);
  }
  URL.revokeObjectURL(previewUrl);
  if (!confirmed) return;
  await sendRichFile(file, type);
}

// ── 拖拽文件到聊天区发送 ───────────────────────────
let dragDepth = 0;
$messages.addEventListener('dragover', (e) => { e.preventDefault(); });
$messages.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  $('#dropOverlay').style.display = 'flex';
});
$messages.addEventListener('dragleave', () => {
  dragDepth--;
  if (dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').style.display = 'none'; }
});
$messages.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').style.display = 'none';
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  confirmAndSendFile(files[0]);
});

// 发送富媒体文件（文件选择器 / Ctrl+V 粘贴共用）
async function sendRichFile(file, mediaType) {
  if (!currentConv) { showToast('⚠ 请先选择一个群聊'); return; }

  const fileSizeMB = file.size / (1024 * 1024);
  const softLimits = { image: 20, video: 30, voice: 200, file: 200 };
  const hardLimit = 200;

  // 硬限制检查
  if (fileSizeMB > hardLimit) {
    showConfirm('当前媒体大小已超过硬限制（200MB），无法发送', 'error', false, false);
    return;
  }

  // 软限制检查
  const softLimit = softLimits[mediaType] || 200;
  if (fileSizeMB > softLimit) {
    const typeName = { image: '图片', video: '视频', voice: '语音', file: '文件' }[mediaType] || '媒体';
    if (!(await showConfirm(`当前${typeName}大小已超过软限制（${softLimit}MB），继续发送将转为文件发送（当前 QQ API 不稳定，文件发送几乎 100% 失败，你确认要继续发送吗？）`, 'query', false))) return;
  }
  const placeholderMap = {image:'[图片]', video:'[视频]', voice:'[语音]', file:'[文件]'};
  const placeholder = placeholderMap[mediaType] || '[图片]';
  pendingContents.add(placeholder);
  const tempId = `rich_${++pendingId}`;
  const blobUrl = URL.createObjectURL(file);
  const pendingDiv = document.createElement('div');
  pendingDiv.className = 'msg-row out pending';
  pendingDiv.dataset.pendingId = tempId;
  pendingDiv.innerHTML = `
    ${msgAvatarHtml('outgoing', '', botDisplayName)}
    <div class="msg-body">
      ${isDirectConv() ? '' : msgMetaHtml('outgoing', botDisplayName, '')}
      <div style="display:flex;align-items:center;gap:8px;flex-direction:row-reverse;">
        <div class="msg-bubble${mediaType !== 'file' ? ' media-only' : ''}">
          <div class="img-placeholder" style="cursor:pointer;" title="点击全屏播放" onclick="viewMedia(event)">${mediaType === 'video'
            ? `<div class="video-play-btn"></div><video src="${blobUrl}" class="msg-video" muted playsinline preload="metadata" style="max-width:280px;max-height:280px;border-radius:8px;opacity:0.7;position:relative;z-index:2;pointer-events:none;" oncontextmenu="event.stopPropagation()"></video>`
            : mediaType === 'voice'
            ? `<audio src="${blobUrl}" class="msg-audio" controls preload="auto" style="max-width:280px;opacity:0.7;position:relative;z-index:2;pointer-events:auto;" oncontextmenu="event.stopPropagation()"></audio>`
            : mediaType === 'file'
            ? `<div class="file-card" style="opacity:0.7;"><span class="file-icon"><img src="icons/${fileIconName(file.name)}.svg" class="svg-icon" style="width:20px;height:20px;" alt=""></span><div class="file-info"><div class="file-name">${escHtml(file.name)}</div><div class="file-size">${formatFileSize(file.size)}</div></div></div>`
            : `<img src="${blobUrl}" class="msg-image" style="max-width:280px;max-height:280px;object-fit:cover;border-radius:8px;opacity:0.7;cursor:pointer;" onclick="event.stopPropagation();viewMedia(event)">`}</div>
          <div style="font-size:0.75em;color:var(--text-dim);">上传中…</div>
        </div>
        <button class="msg-retry" onclick="retryRichSend('${tempId}')" title="重发" style="display:none;">!</button>
      </div>
    </div>
  `;
  bindMsgContextMenu(pendingDiv);
  $messages.appendChild(pendingDiv);
  scrollBottom();

  try {
    // 第一步：上传到图床
    const form = new FormData();
    form.append('file', file);
    const upR = await fetch('/api/upload-file', { method: 'POST', body: form }).then(r => r.json());
    if (upR.code !== 200) {
      pendingContents.delete(placeholder);
      const previewEl = pendingDiv.querySelector('img, video, audio');
      if (previewEl) previewEl.style.opacity = '1';
      const failStatus = pendingDiv.querySelector('.msg-bubble > div:last-of-type');
      if (failStatus) failStatus.style.display = 'none';  // 失败只显示感叹号
      pendingDiv.classList.add('failed');
      pendingDiv.querySelector('.msg-retry').style.display = '';
      return;
    }

    const fileUrl = upR.url || (fileServerUrl ? `${fileServerUrl}/get/${upR.file_id}` : upR.url || '');
    pendingDiv.querySelector('.msg-bubble > div:last-of-type').textContent = '发送中…';

    // 第二步：通过 QQ API 发送
    const sendR = await API('/api/send-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conv_id: currentConv, url: fileUrl, file_type: mediaType, file_name: file.name }),
    });
    if (sendR.error || !sendR.ok) {
      pendingContents.delete(placeholder);
      const previewEl2 = pendingDiv.querySelector('img, video, audio');
      if (previewEl2) previewEl2.style.opacity = '1';
      const failStatus2 = pendingDiv.querySelector('.msg-bubble > div:last-of-type');
      if (failStatus2) failStatus2.style.display = 'none';  // 失败只显示感叹号
      pendingDiv.classList.add('failed');
      pendingDiv.querySelector('.msg-retry').style.display = '';
      return;
    }

    // 成功：清除半透明 + pending 状态
    const previewEl3 = pendingDiv.querySelector('img, video, audio');
    if (previewEl3) previewEl3.style.opacity = '1';
    // 文件卡片
    const fileCard = pendingDiv.querySelector('.file-card');
    if (fileCard) fileCard.style.opacity = '1';
    const statusDiv = pendingDiv.querySelector('.msg-bubble > div:last-of-type');
    if (statusDiv) statusDiv.remove();
    pendingDiv.classList.remove('pending');
    pendingDiv.querySelectorAll('*').forEach(el => {
      if (el.style.opacity === '0.7') el.style.opacity = '1';
    });
    if (sendR.message && sendR.message.id) {
      pendingDiv.dataset.msgId = sendR.message.id;
      pendingDiv.dataset.msgDirection = 'outgoing';
      pendingDiv.dataset.msgContent = placeholder;
      pendingDiv.dataset.msgSender = sendR.message.sender_name || '';
      pendingDiv.dataset.msgTimestamp = sendR.message.timestamp || '';
      pendingDiv.dataset.msgRefIdx = sendR.message.ref_idx || '';
      pendingDiv.removeAttribute('data-pending-id');
      lastMsgId = Math.max(lastMsgId, sendR.message.id);
    }
    pendingContents.delete(placeholder);
  } catch (e) {
    pendingContents.delete(placeholder);
    const previewEl4 = pendingDiv.querySelector('img, video, audio');
    if (previewEl4) previewEl4.style.opacity = '1';
    const failStatus3 = pendingDiv.querySelector('.msg-bubble > div:last-of-type');
    if (failStatus3) failStatus3.style.display = 'none';  // 失败只显示感叹号
    pendingDiv.classList.add('failed');
    pendingDiv.querySelector('.msg-retry').style.display = '';
  }
}

