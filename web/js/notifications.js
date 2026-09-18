// notifications.js - 非当前账号的新消息提醒

function notificationEscape(value) {
  const node = document.createElement('div');
  node.textContent = value == null ? '' : String(value);
  return node.innerHTML;
}

class NotificationManager {
  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'account-notification-container';
    this.container.setAttribute('aria-live', 'polite');
    document.body.appendChild(this.container);
    this.audio = new Audio('/sounds/notification.wav');
    this.audio.preload = 'auto';
    this.audio.volume = 0.48;
    this.unlockAudio();
    window.addEventListener('neonbot:new-message', event => this.handle(event.detail));
  }

  unlockAudio() {
    document.addEventListener('pointerdown', () => {
      const volume = this.audio.volume;
      this.audio.volume = 0;
      this.audio.play().then(() => {
        this.audio.pause();
        this.audio.currentTime = 0;
        this.audio.volume = volume;
      }).catch(() => {
        this.audio.volume = volume;
      });
    }, { once: true });
  }

  activeAccountId() {
    return window.accountManager?.getCurrentAccountId()
      || localStorage.getItem('neonbot_active_account')
      || '';
  }

  handle(message) {
    if (!message || message.direction !== 'incoming') return;
    const accountId = message.account_id || '';
    if (!accountId || accountId === this.activeAccountId()) return;
    const account = window.accountManager?.accounts.find(item => item.appid === accountId) || {
      appid: accountId,
      bot_name: message.account_name || accountId,
      bot_avatar: '',
    };
    this.playSound();
    this.show(message, account);
  }

  show(message, account) {
    const sender = message.sender_name || '未知用户';
    const accountName = account.bot_name || account.appid;
    const accountInitial = [...accountName][0] || '?';
    const senderInitial = [...sender][0] || '?';
    const accountAvatar = account.bot_avatar
      ? `<img src="${notificationEscape(account.bot_avatar)}" alt="">`
      : notificationEscape(accountInitial);
    const senderAvatar = message.sender_avatar
      ? `<img src="${notificationEscape(message.sender_avatar)}" alt="">`
      : notificationEscape(senderInitial);
    const preview = this.preview(message.content);
    const bubble = document.createElement('button');
    bubble.type = 'button';
    bubble.className = 'account-notification-bubble';
    bubble.innerHTML = `
      <span class="notification-account-avatar">${accountAvatar}</span>
      <span class="notification-copy">
        <span class="notification-title">你有一条新消息</span>
        <span class="notification-account-name">${notificationEscape(accountName)}</span>
        <span class="notification-sender-row">
          <span class="notification-sender-avatar">${senderAvatar}</span>
          <span class="notification-sender-name">${notificationEscape(sender)}</span>
        </span>
        <span class="notification-preview">${notificationEscape(preview)}</span>
      </span>`;
    bubble.addEventListener('click', async () => {
      this.remove(bubble);
      if (window.accountManager) {
        await window.accountManager.switchAccount(account.appid, message.conversation_id || '');
      }
    });
    this.container.appendChild(bubble);
    setTimeout(() => this.remove(bubble), 3000);
  }

  preview(content) {
    const text = String(content || '[新消息]').replace(/\s+/g, ' ').trim();
    return text.length > 46 ? `${text.slice(0, 46)}...` : text;
  }

  playSound() {
    this.audio.currentTime = 0;
    this.audio.play().catch(() => {});
  }

  remove(bubble) {
    if (!bubble?.isConnected || bubble.classList.contains('hiding')) return;
    bubble.classList.add('hiding');
    setTimeout(() => bubble.remove(), 260);
  }
}

const notificationManager = new NotificationManager();
window.notificationManager = notificationManager;
