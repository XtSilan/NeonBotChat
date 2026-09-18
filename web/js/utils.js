// ── Toast ─────────────────────────────────────────────
// Toast 队列：同一时间只显示一个，当前显示完再显示下一个
const toastQueue = [];
let toastShowing = false;

function showToast(msg) {
  toastQueue.push(msg);
  pumpToast();
}

function pumpToast() {
  if (toastShowing || toastQueue.length === 0) return;
  toastShowing = true;
  const text = toastQueue.shift();
  const el = document.createElement('div');
  el.className = 'toast';
  // 前缀 emoji → 对应图标：✅✓→ok, ⭐→favourite, ⚠→warning
  const m = text.match(/^([✅✓⭐⚠])\s*/);
  if (m) {
    const iconName = m[1] === '⭐' ? 'favourite' : m[1] === '⚠' ? 'warning' : 'ok';
    el.innerHTML = `<div class="toast-icon"><img src="icons/${iconName}.svg" class="svg-icon" alt=""></div><div class="toast-text">${escHtml(text.slice(m[0].length))}</div>`;
  } else {
    el.innerHTML = `<div class="toast-text">${escHtml(text)}</div>`;
  }
  $('#toastContainer').appendChild(el);
  // 2s 后移除（toastIn 0.25s + 停留 + toastOut 0.25s），随后显示队列中下一个
  setTimeout(() => {
    el.remove();
    toastShowing = false;
    setTimeout(pumpToast, 120);  // 小间隔，视觉上逐条出现
  }, 2000);
}

