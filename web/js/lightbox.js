// ── 图片/视频灯箱 ───────────────────────────────────
const lightboxItems = [];  // [{src, type: 'image'|'video'}]
let lightboxIndex = 0;

function viewImage(src, items = null, index = 0) {
  if (selectMode) return;
  lightboxItems.length = 0;
  if (items && items.length > 0) {
    lightboxItems.push(...items);
    lightboxIndex = Math.min(Math.max(index, 0), items.length - 1);
  } else {
    lightboxItems.push({ src, type: 'image' });
    lightboxIndex = 0;
  }
  showLightbox();
}

// 点击图/视频：收集整个会话已加载的媒体，按 DOM 顺序排列（QQ 多图常为多条消息）
function viewMedia(event) {
  // 视频 pointer-events:none，点击穿透到外层 .img-placeholder：
  // 需先查容器内部的媒体元素，再查点击元素本身，最后才退回点击元素
  const t = event.target;
  const holder = t.closest ? t.closest('.img-placeholder') : null;
  const el = (holder && holder.querySelector('.msg-image, .msg-video')) || (t.closest ? t.closest('.msg-image, .msg-video') : null) || t;
  const mediaEls = [...$messages.querySelectorAll('.msg-image, .msg-video')];
  const items = mediaEls
    .map(im => ({ src: im.currentSrc || im.src || '', type: im.classList.contains('msg-image') ? 'image' : 'video' }))
    .filter(it => it.src);
  // 用元素引用定位索引（URL 字符串可能因重定向/时序不一致，元素引用必然准确）
  let idx = mediaEls.indexOf(el);
  if (idx < 0 || idx >= items.length || !items[idx].src) {
    const src = el.currentSrc || el.src || '';
    idx = items.findIndex(it => it.src === src);
  }
  viewImage(el.currentSrc || el.src || '', items, idx < 0 ? 0 : idx);
}

function showLightbox() {
  // 保险：暂停会话里所有视频，避免与灯箱同时播放
  $messages.querySelectorAll('.msg-video').forEach(v => v.pause());
  const item = lightboxItems[lightboxIndex];
  const img = $('#lightboxImg');
  const video = $('#lightboxVideo');
  // 重置失败提示和缩放
  $('#lightboxError').style.display = 'none';
  $('#lightboxZoom').style.display = 'none';
  clearTimeout(lightboxZoomTimer);
  img.style.display = 'block';
  img.style.transform = '';
  video.style.transform = '';
  lightboxScale = 1;
  if (item.type === 'video') {
    // 暂停并卸掉上一个媒体
    video.pause();
    img.style.display = 'none';
    video.style.display = 'block';
    video.style.opacity = '0';
    video.src = item.src;
    video.load();
    video.play().catch(() => {});
    video.onloadeddata = () => { video.style.opacity = '1'; };
  } else {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.style.display = 'none';
    img.style.display = 'block';
    img.style.opacity = '0';
    img.src = item.src;
  }
  $('#lightboxCounter').textContent = `${lightboxIndex + 1} / ${lightboxItems.length}`;
  $('#lightboxPrev').style.display = lightboxItems.length > 1 ? '' : 'none';
  $('#lightboxNext').style.display = lightboxItems.length > 1 ? '' : 'none';
  $('#lightbox').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  const video = $('#lightboxVideo');
  video.pause();
  video.removeAttribute('src');
  video.load();
  $('#lightbox').style.display = 'none';
  document.body.style.overflow = '';
  $('#lightboxImg').src = '';
}

function lightboxNav(dir) {
  if (dir < 0 && lightboxIndex <= 0) { showToast('已是第一张'); return; }
  if (dir > 0 && lightboxIndex >= lightboxItems.length - 1) { showToast('已是最后一张'); return; }
  lightboxIndex += dir;
  showLightbox();
}

$('#lightboxClose').addEventListener('click', closeLightbox);
$('#lightboxBackdrop').addEventListener('click', closeLightbox);
$('#lightboxPrev').addEventListener('click', () => lightboxNav(-1));
$('#lightboxNext').addEventListener('click', () => lightboxNav(1));
$('#lightboxImg').addEventListener('load', () => { $('#lightboxImg').style.opacity = '1'; });
$('#lightboxImg').addEventListener('error', () => {
  $('#lightboxImg').style.opacity = '1';
  $('#lightboxImg').style.display = 'none';
  $('#lightboxError').textContent = '图片已过期';
  $('#lightboxError').style.display = 'block';
});
$('#lightboxVideo').addEventListener('error', () => {
  $('#lightboxError').textContent = '视频已过期';
  $('#lightboxError').style.display = 'block';
});
document.addEventListener('keydown', (e) => {
  if ($('#lightbox').style.display !== 'flex') return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') lightboxNav(-1);
  else if (e.key === 'ArrowRight') lightboxNav(1);
});
// 移动端：单指滑动切换 + 双指缩放
let lightboxTouchX = null, lightboxTouchY = null;
let lightboxPinchDist = null;
let lightboxScale = 1;
let lightboxZoomTimer = null;

function applyLightboxScale(s) {
  lightboxScale = Math.min(Math.max(s, 0.5), 4);
  const img = $('#lightboxImg');
  const video = $('#lightboxVideo');
  if (img.style.display !== 'none') img.style.transform = `scale(${lightboxScale})`;
  else video.style.transform = `scale(${lightboxScale})`;
  // 中央显示缩放比例，停止缩放后淡出
  const $zoom = $('#lightboxZoom');
  $zoom.textContent = Math.round(lightboxScale * 100) + '%';
  $zoom.style.display = 'block';
  clearTimeout(lightboxZoomTimer);
  lightboxZoomTimer = setTimeout(() => { $zoom.style.display = 'none'; }, 600);
}

$('#lightbox').addEventListener('touchstart', (e) => {
  if (e.touches.length >= 2) {
    const [a, b] = e.touches;
    lightboxPinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    lightboxTouchX = lightboxTouchY = null;  // 双指时不处理滑动
  } else {
    lightboxPinchDist = null;
    lightboxTouchX = e.touches[0].clientX;
    lightboxTouchY = e.touches[0].clientY;
  }
}, { passive: true });

$('#lightbox').addEventListener('touchmove', (e) => {
  if (e.touches.length >= 2 && lightboxPinchDist !== null) {
    e.preventDefault();  // 阻止浏览器页面级缩放/滚动
    const [a, b] = e.touches;
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (d > 0) {
      applyLightboxScale(lightboxScale * (d / lightboxPinchDist));
      lightboxPinchDist = d;
    }
  }
}, { passive: false });

$('#lightbox').addEventListener('touchend', (e) => {
  if (lightboxPinchDist !== null || e.changedTouches.length >= 2) { lightboxPinchDist = null; return; }
  if (lightboxTouchX === null) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - lightboxTouchX;
  const dy = t.clientY - lightboxTouchY;
  lightboxTouchX = lightboxTouchY = null;
  if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;  // 阈值 + 水平主导
  lightboxNav(dx < 0 ? 1 : -1);  // 左滑下一张，右滑上一张
}, { passive: true });

// 桌面端：滚轮缩放
$('#lightbox').addEventListener('wheel', (e) => {
  e.preventDefault();
  applyLightboxScale(lightboxScale * (e.deltaY < 0 ? 1.1 : 0.9));
}, { passive: false });

function scrollBottom() {
  // 先立刻滚一次
  $messages.scrollTop = $messages.scrollHeight;
  // 等一帧再滚（处理 DOM 渲染）
  requestAnimationFrame(() => {
    $messages.scrollTop = $messages.scrollHeight;
  });
  // 等所有图片加载完再滚一次
  const imgs = $messages.querySelectorAll('.msg-image');
  if (imgs.length > 0) {
    let pending = imgs.length;
    const onDone = () => {
      pending--;
      if (pending === 0) {
        $messages.scrollTop = $messages.scrollHeight;
      }
    };
    imgs.forEach(img => {
      if (img.complete) {
        onDone();
      } else {
        img.addEventListener('load', onDone, { once: true });
        img.addEventListener('error', onDone, { once: true });
      }
    });
    // 兜底：300ms 后再滚一次
    setTimeout(() => { $messages.scrollTop = $messages.scrollHeight; }, 300);
  }
}

