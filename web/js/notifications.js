// notifications.js — 消息通知逻辑
// 处理新消息提醒、提示音和气泡动画

class NotificationManager {
  constructor() {
    this.container = null;
    this.audio = null;
    this.enabled = true;
    this.init();
  }
  
  init() {
    // 创建容器
    this.container = document.createElement('div');
    this.container.className = 'notification-container';
    this.container.id = 'notificationContainer';
    document.body.appendChild(this.container);
    
    // 加载提示音
    this.audio = new Audio('/sounds/notification.wav');
    this.audio.volume = 0.5;
    
    // 从本地存储读取设置
    this.enabled = localStorage.getItem('desktop_notify') !== '0';
  }
  
  isEnabled() {
    return this.enabled;
  }
  
  setEnabled(enabled) {
    this.enabled = enabled;
    localStorage.setItem('desktop_notify', enabled ? '1' : '0');
  }
  
  show(accountName, senderName, message, avatar, accountId) {
    if (!this.enabled) return;
    
    // 检查是否是当前查看的会话
    if (typeof currentConv !== 'undefined' && currentConv === accountId) {
      return;
    }
    
    // 播放提示音
    this.playSound();
    
    // 创建气泡
    const bubble = document.createElement('div');
    bubble.className = 'notification-bubble';
    bubble.innerHTML = `
      <div class="avatar">
        ${avatar 
          ? `<img src="${avatar}" style="width:100%;height:100%;border-radius:50%;">` 
          : senderName ? senderName[0] : '?'}
      </div>
      <div class="content">
        <div class="account-name">${accountName || '未知账号'}</div>
        <div class="sender-name">${senderName || '未知用户'}</div>
        <div class="message-preview">${this.formatMessage(message)}</div>
      </div>
    `;
    
    // 点击气泡跳转到会话
    bubble.addEventListener('click', () => {
      if (typeof selectConv === 'function' && accountId) {
        selectConv(accountId);
      }
      this.removeBubble(bubble);
    });
    
    this.container.appendChild(bubble);
    
    // 3秒后自动隐藏
    setTimeout(() => {
      this.removeBubble(bubble);
    }, 3000);
  }
  
  removeBubble(bubble) {
    if (bubble && bubble.parentNode) {
      bubble.classList.add('hiding');
      setTimeout(() => {
        if (bubble.parentNode) {
          bubble.parentNode.removeChild(bubble);
        }
      }, 300);
    }
  }
  
  formatMessage(message) {
    if (!message) return '[新消息]';
    
    // 截断过长的消息
    let formatted = String(message).replace(/\s+/g, ' ').trim();
    if (formatted.length > 50) {
      formatted = formatted.substring(0, 50) + '...';
    }
    
    // 处理特殊消息类型
    if (formatted.startsWith('[图片]')) return '[图片]';
    if (formatted.startsWith('[视频]')) return '[视频]';
    if (formatted.startsWith('[语音]')) return '[语音]';
    if (formatted.startsWith('[文件]')) return '[文件]';
    
    return formatted;
  }
  
  playSound() {
    if (!this.audio) return;
    
    // 重置音频位置
    this.audio.currentTime = 0;
    
    // 播放提示音
    const playPromise = this.audio.play();
    if (playPromise !== undefined) {
      playPromise.catch(e => {
        console.log('播放提示音失败:', e);
      });
    }
  }
  
  // 检查浏览器通知权限
  async requestPermission() {
    if (!('Notification' in window)) {
      console.log('此浏览器不支持桌面通知');
      return false;
    }
    
    if (Notification.permission === 'granted') {
      return true;
    }
    
    if (Notification.permission !== 'denied') {
      const permission = await Notification.requestPermission();
      return permission === 'granted';
    }
    
    return false;
  }
  
  // 显示桌面通知（备用）
  showDesktopNotification(title, body, icon) {
    if (!('Notification' in window) || Notification.permission !== 'granted') {
      return;
    }
    
    try {
      const notification = new Notification(title, {
        body: body,
        icon: icon || '/icons/bot.svg',
        tag: 'neonbot-notification'
      });
      
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
      
      setTimeout(() => notification.close(), 5000);
    } catch (e) {
      console.log('显示桌面通知失败:', e);
    }
  }
}

// 全局实例
const notificationManager = new NotificationManager();

// 处理新消息通知
function handleNewMessageNotification(msg) {
  if (!msg) return;
  
  // 系统消息不通知
  if (msg.direction === 'center') return;
  
  // 自己发的消息不通知
  if (msg.direction === 'outgoing') return;
  
  // 获取账号信息
  const accountName = msg.account_name || '未知账号';
  const senderName = msg.sender_name || '未知用户';
  const message = msg.content || '[新消息]';
  const avatar = msg.sender_avatar || '';
  const accountId = msg.conversation_id || '';
  
  // 显示通知气泡
  notificationManager.show(accountName, senderName, message, avatar, accountId);
}

// 在 WebSocket 消息处理中调用
if (typeof handleIncomingMessage === 'function') {
  const originalHandleIncomingMessage = handleIncomingMessage;
  handleIncomingMessage = function(msg) {
    // 调用原函数
    originalHandleIncomingMessage(msg);
    
    // 显示通知
    handleNewMessageNotification(msg);
  };
}
