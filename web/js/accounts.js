// accounts.js — 账号管理逻辑
// 处理登录页面和账号切换功能

class LoginManager {
  constructor() {
    this.accounts = [];
  }
  
  async init() {
    await this.loadAccounts();
    this.bindEvents();
  }
  
  async loadAccounts() {
    try {
      const resp = await fetch('/api/accounts');
      const data = await resp.json();
      this.accounts = data.accounts || [];
      this.renderAccountList();
    } catch (e) {
      console.error('加载账号失败:', e);
    }
  }
  
  renderAccountList() {
    const container = document.getElementById('accountList');
    if (!container) return;
    
    if (!this.accounts.length) {
      container.innerHTML = '<p class="no-accounts">暂无保存的账号</p>';
      return;
    }
    
    container.innerHTML = this.accounts.map(acc => `
      <div class="account-item" data-appid="${acc.appid}">
        <div class="avatar">
          ${acc.bot_avatar 
            ? `<img src="${acc.bot_avatar}" style="width:100%;height:100%;border-radius:50%;">` 
            : acc.bot_name ? acc.bot_name[0] : acc.appid[0]}
        </div>
        <div class="info">
          <div class="name">${acc.bot_name || acc.appid}</div>
          <div class="appid">${acc.appid}</div>
        </div>
        <div class="status ${acc.is_running ? 'online' : 'offline'}">
          ${acc.is_running ? '在线' : '离线'}
        </div>
      </div>
    `).join('');
    
    // 绑定点击事件
    container.querySelectorAll('.account-item').forEach(item => {
      item.addEventListener('click', () => {
        const appid = item.dataset.appid;
        this.loginWithSaved(appid);
      });
    });
  }
  
  async loginWithSaved(appid) {
    try {
      const resp = await fetch(`/api/accounts/${appid}/switch`, {
        method: 'POST'
      });
      const data = await resp.json();
      if (data.ok) {
        window.location.href = '/';
      } else {
        alert(data.error || '登录失败');
      }
    } catch (e) {
      console.error('登录失败:', e);
      alert('网络错误: ' + e.message);
    }
  }
  
  bindEvents() {
    const form = document.getElementById('loginForm');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.loginWithNew();
      });
    }
  }
  
  async loginWithNew() {
    const appid = document.getElementById('loginAppid').value.trim();
    const secret = document.getElementById('loginSecret').value.trim();
    const remember = document.getElementById('rememberAccount').checked;
    
    if (!appid || !secret) {
      alert('请输入 AppID 和 Secret');
      return;
    }
    
    try {
      const resp = await fetch('/api/accounts/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appid, secret, remember })
      });
      
      const data = await resp.json();
      if (data.ok) {
        window.location.href = '/';
      } else {
        alert(data.error || '登录失败');
      }
    } catch (e) {
      alert('网络错误: ' + e.message);
    }
  }
}

class AccountManager {
  constructor() {
    this.accounts = [];
    this.currentAccount = null;
    this.switcherVisible = false;
  }
  
  async init() {
    await this.loadAccounts();
    this.bindEvents();
  }
  
  async loadAccounts() {
    try {
      const resp = await fetch('/api/accounts');
      const data = await resp.json();
      this.accounts = data.accounts || [];
      this.renderAccountSwitcher();
    } catch (e) {
      console.error('加载账号失败:', e);
    }
  }
  
  async getCurrentAccount() {
    try {
      const resp = await fetch('/api/accounts/current');
      const data = await resp.json();
      if (data.ok) {
        this.currentAccount = data.account;
        this.updateCurrentAccountUI();
      }
    } catch (e) {
      console.error('获取当前账号失败:', e);
    }
  }
  
  updateCurrentAccountUI() {
    const avatarEl = document.getElementById('railBotAvatar');
    const nameEl = document.getElementById('mobileBotName');
    const statusDot = document.getElementById('railStatusDot');
    
    if (this.currentAccount) {
      // 更新头像
      if (avatarEl) {
        if (this.currentAccount.bot_avatar) {
          avatarEl.innerHTML = `<img src="${this.currentAccount.bot_avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
        } else {
          avatarEl.innerHTML = `<img src="icons/query.svg" class="svg-icon" style="width:22px;height:22px;" alt="">`;
        }
      }
      
      // 更新名称
      if (nameEl) {
        nameEl.textContent = this.currentAccount.bot_name || 'Bot';
      }
      
      // 更新状态点
      if (statusDot) {
        statusDot.style.background = this.currentAccount.is_running ? 'var(--online)' : 'var(--danger)';
      }
    }
  }
  
  renderAccountSwitcher() {
    const switcher = document.getElementById('accountSwitcher');
    if (!switcher) return;
    
    if (this.accounts.length <= 1) {
      switcher.style.display = 'none';
      return;
    }
    
    switcher.innerHTML = this.accounts.map(acc => `
      <div class="account-switch-item ${acc.is_active ? 'active' : ''}" data-appid="${acc.appid}">
        <div class="avatar">
          ${acc.bot_avatar 
            ? `<img src="${acc.bot_avatar}" style="width:100%;height:100%;border-radius:50%;">` 
            : acc.bot_name ? acc.bot_name[0] : acc.appid[0]}
        </div>
        <div class="info">
          <div class="name">${acc.bot_name || acc.appid}</div>
          <div class="status">${acc.is_running ? '在线' : '离线'}</div>
        </div>
        <button class="remove-btn" data-appid="${acc.appid}" title="删除账号">×</button>
      </div>
    `).join('');
    
    // 绑定切换事件
    switcher.querySelectorAll('.account-switch-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('remove-btn')) return;
        const appid = item.dataset.appid;
        this.switchAccount(appid);
      });
    });
    
    // 绑定删除事件
    switcher.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const appid = btn.dataset.appid;
        this.removeAccount(appid);
      });
    });
  }
  
  async switchAccount(appid) {
    try {
      const resp = await fetch(`/api/accounts/${appid}/switch`, {
        method: 'POST'
      });
      const data = await resp.json();
      if (data.ok) {
        this.currentAccount = this.accounts.find(a => a.appid === appid);
        this.updateCurrentAccountUI();
        this.toggleSwitcher(false);
        
        // 重新加载数据
        if (typeof loadConversations === 'function') {
          await loadConversations();
        }
        if (typeof loadStats === 'function') {
          await loadStats();
        }
      } else {
        alert(data.error || '切换失败');
      }
    } catch (e) {
      console.error('切换账号失败:', e);
      alert('网络错误: ' + e.message);
    }
  }
  
  async removeAccount(appid) {
    if (!confirm('确定要删除这个账号吗？')) {
      return;
    }
    
    try {
      const resp = await fetch(`/api/accounts/${appid}`, {
        method: 'DELETE'
      });
      const data = await resp.json();
      if (data.ok) {
        await this.loadAccounts();
        await this.getCurrentAccount();
      } else {
        alert(data.error || '删除失败');
      }
    } catch (e) {
      console.error('删除账号失败:', e);
      alert('网络错误: ' + e.message);
    }
  }
  
  toggleSwitcher(show) {
    const switcher = document.getElementById('accountSwitcher');
    if (switcher) {
      this.switcherVisible = show !== undefined ? show : !this.switcherVisible;
      switcher.style.display = this.switcherVisible ? 'block' : 'none';
    }
  }
  
  bindEvents() {
    // 点击头像切换账号
    const avatarBtn = document.getElementById('railBotAvatar');
    if (avatarBtn) {
      avatarBtn.addEventListener('click', () => {
        this.toggleSwitcher();
      });
    }
    
    // 添加账号按钮
    const addBtn = document.getElementById('btnAddAccount');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        this.showAddAccountModal();
      });
    }
    
    // 点击其他地方关闭切换器
    document.addEventListener('click', (e) => {
      const switcher = document.getElementById('accountSwitcher');
      const avatarBtn = document.getElementById('railBotAvatar');
      if (switcher && avatarBtn) {
        if (!switcher.contains(e.target) && !avatarBtn.contains(e.target)) {
          this.toggleSwitcher(false);
        }
      }
    });
  }
  
  showAddAccountModal() {
    const modal = document.getElementById('addAccountModal');
    if (modal) {
      modal.style.display = 'flex';
      document.getElementById('newAppid').value = '';
      document.getElementById('newSecret').value = '';
      document.getElementById('addAccountError').style.display = 'none';
    }
  }
  
  hideAddAccountModal() {
    const modal = document.getElementById('addAccountModal');
    if (modal) {
      modal.style.display = 'none';
    }
  }
  
  async addAccount() {
    const appid = document.getElementById('newAppid').value.trim();
    const secret = document.getElementById('newSecret').value.trim();
    const errorEl = document.getElementById('addAccountError');
    
    if (!appid || !secret) {
      errorEl.textContent = '请输入 AppID 和 Secret';
      errorEl.style.display = 'block';
      return;
    }
    
    try {
      const resp = await fetch('/api/accounts/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appid, secret })
      });
      
      const data = await resp.json();
      if (data.ok) {
        this.hideAddAccountModal();
        await this.loadAccounts();
        await this.getCurrentAccount();
        
        // 重新加载数据
        if (typeof loadConversations === 'function') {
          await loadConversations();
        }
      } else {
        errorEl.textContent = data.error || '添加失败';
        errorEl.style.display = 'block';
      }
    } catch (e) {
      errorEl.textContent = '网络错误: ' + e.message;
      errorEl.style.display = 'block';
    }
  }
}

// 全局实例
const accountManager = new AccountManager();
