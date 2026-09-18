// accounts.js - 登录、账号切换与添加账号

function accountEscape(value) {
  const node = document.createElement('div');
  node.textContent = value == null ? '' : String(value);
  return node.innerHTML;
}

function accountAvatar(account, className = 'avatar') {
  const name = account.bot_name || account.appid || '?';
  const content = account.bot_avatar
    ? `<img src="${accountEscape(account.bot_avatar)}" alt="">`
    : accountEscape([...name][0] || '?');
  return `<div class="${className}">${content}</div>`;
}

async function accountJson(response) {
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || '请求失败');
  return data;
}

class LoginManager {
  constructor() {
    this.accounts = [];
  }

  async init() {
    await this.loadAccounts();
    this.bindEvents();
  }

  setError(message = '') {
    const error = document.getElementById('loginError');
    if (!error) return;
    error.textContent = message;
    error.style.display = message ? 'block' : 'none';
  }

  async loadAccounts() {
    try {
      const data = await accountJson(await fetch('/api/accounts'));
      this.accounts = data.accounts || [];
      this.renderAccountList();
    } catch (error) {
      this.setError(error.message);
    }
  }

  renderAccountList() {
    const container = document.getElementById('accountList');
    const saved = document.getElementById('savedAccounts');
    if (!container || !saved) return;
    saved.style.display = this.accounts.length ? '' : 'none';
    container.innerHTML = this.accounts.map(account => `
      <button type="button" class="account-item" data-appid="${accountEscape(account.appid)}">
        ${accountAvatar(account)}
        <span class="info">
          <span class="name">${accountEscape(account.bot_name || account.appid)}</span>
          <span class="appid">${accountEscape(account.appid)}</span>
        </span>
        <span class="status ${account.is_running ? 'online' : 'offline'}">
          ${account.is_running ? '在线' : '离线'}
        </span>
      </button>
    `).join('');
    container.querySelectorAll('.account-item').forEach(item => {
      item.addEventListener('click', () => this.loginWithSaved(item.dataset.appid, item));
    });
  }

  async loginWithSaved(appid, item) {
    this.setError();
    item.disabled = true;
    try {
      await accountJson(await fetch(`/api/accounts/${encodeURIComponent(appid)}/switch`, {
        method: 'POST',
      }));
      window.location.href = '/';
    } catch (error) {
      item.disabled = false;
      this.setError(error.message);
    }
  }

  bindEvents() {
    const form = document.getElementById('loginForm');
    if (form) form.addEventListener('submit', event => {
      event.preventDefault();
      this.loginWithNew();
    });
  }

  async loginWithNew() {
    const appid = document.getElementById('loginAppid').value.trim();
    const secret = document.getElementById('loginSecret').value.trim();
    const submit = document.getElementById('loginSubmit');
    this.setError();
    if (!appid || !secret) {
      this.setError('请输入 AppID 和 AppSecret');
      return;
    }
    submit.disabled = true;
    submit.textContent = '登录中...';
    try {
      await accountJson(await fetch('/api/accounts/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appid, secret }),
      }));
      window.location.href = '/';
    } catch (error) {
      this.setError(error.message);
      submit.disabled = false;
      submit.textContent = '登录';
    }
  }
}

class AccountManager {
  constructor() {
    this.accounts = [];
    this.currentAccount = null;
    this.eventsBound = false;
  }

  async init() {
    await Promise.all([this.loadAccounts(), this.getCurrentAccount()]);
    this.bindEvents();
  }

  getCurrentAccountId() {
    return this.currentAccount?.appid || localStorage.getItem('neonbot_active_account') || '';
  }

  async loadAccounts() {
    try {
      const data = await accountJson(await fetch('/api/accounts'));
      this.accounts = data.accounts || [];
      this.renderAccountSwitcher();
      this.renderRobotList();
      this.updateCurrentAccountUI();
    } catch (error) {
      console.error('加载账号失败:', error);
    }
  }

  async getCurrentAccount() {
    try {
      const data = await accountJson(await fetch('/api/accounts/current'));
      this.currentAccount = data.ok ? data.account : null;
      if (this.currentAccount) {
        localStorage.setItem('neonbot_active_account', this.currentAccount.appid);
      } else {
        localStorage.removeItem('neonbot_active_account');
      }
      this.renderAccountSwitcher();
      this.renderRobotList();
      this.updateCurrentAccountUI();
    } catch (error) {
      console.error('获取当前账号失败:', error);
    }
  }

  updateCurrentAccountUI() {
    const primary = this.accounts[0] || this.currentAccount;
    const active = this.currentAccount || primary;
    if (!primary && !active) return;
    const avatar = document.getElementById('railBotAvatar');
    const mobileAvatar = document.getElementById('mobileBotAvatarImg');
    const name = document.getElementById('mobileBotName');
    const status = document.getElementById('railStatusDot');
    const mobileStatus = document.getElementById('mobileStatusDot');
    if (avatar && primary) {
      avatar.innerHTML = primary.bot_avatar
        ? `<img src="${accountEscape(primary.bot_avatar)}" alt="${accountEscape(primary.bot_name || 'Bot')}">`
        : `<span class="account-avatar-fallback">${accountEscape([...(primary.bot_name || primary.appid || '?')][0])}</span>`;
      avatar.title = `${primary.bot_name || primary.appid} · 点击进入聊天`;
      avatar.classList.toggle('active', active?.appid === primary.appid);
    }
    if (mobileAvatar) {
      if (active?.bot_avatar) {
        mobileAvatar.classList.remove('svg-icon');
        mobileAvatar.src = active.bot_avatar;
      } else {
        mobileAvatar.classList.add('svg-icon');
        mobileAvatar.src = 'icons/query.svg';
      }
    }
    if (name) name.textContent = active?.bot_name || active?.appid || 'Bot';
    if (status) status.style.background = primary?.is_running === false ? 'var(--danger)' : 'var(--online)';
    if (mobileStatus) mobileStatus.style.background = active?.is_running === false ? 'var(--danger)' : 'var(--online)';
  }

  renderAccountSwitcher() {
    const switcher = document.getElementById('accountSwitcher');
    if (!switcher) return;
    if (!this.accounts.length) {
      switcher.innerHTML = '';
      return;
    }
    const activeId = this.getCurrentAccountId();
    const additionalAccounts = this.accounts.slice(1);
    switcher.innerHTML = `
      ${additionalAccounts.map(account => `
        <button type="button" class="account-switch-item ${account.appid === activeId ? 'active' : ''}" data-appid="${accountEscape(account.appid)}" title="${accountEscape(account.bot_name || account.appid)}" aria-label="切换到 ${accountEscape(account.bot_name || account.appid)}">
          ${accountAvatar(account)}
        </button>
      `).join('')}
    `;
    switcher.querySelectorAll('.account-switch-item').forEach(item => {
      const activate = event => {
        if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        this.switchAccount(item.dataset.appid);
      };
      item.addEventListener('click', activate);
      item.addEventListener('keydown', activate);
    });
  }

  renderRobotList() {
    const container = document.getElementById('robotListItems');
    if (!container) return;
    const activeId = this.getCurrentAccountId();
    if (!this.accounts.length) {
      container.innerHTML = '<div class="robot-list-empty">暂无机器人，请先添加账号</div>';
      return;
    }
    container.innerHTML = this.accounts.map(account => `
      <div class="robot-list-item ${account.appid === activeId ? 'active' : ''}" data-appid="${accountEscape(account.appid)}" role="button" tabindex="0">
        ${accountAvatar(account)}
        <div class="robot-info">
          <div class="robot-name">${accountEscape(account.bot_name || account.appid)}</div>
          <div class="robot-meta">${accountEscape(account.appid)} · ${account.is_running ? '运行中' : '未运行'}</div>
        </div>
        <div class="robot-list-actions">
          <button type="button" class="robot-list-action" data-action="edit" data-appid="${accountEscape(account.appid)}" title="编辑名称" aria-label="编辑名称">✎</button>
          <button type="button" class="robot-list-action danger" data-action="delete" data-appid="${accountEscape(account.appid)}" title="删除机器人" aria-label="删除机器人">×</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.robot-list-item').forEach(item => {
      const activate = event => {
        if (event.target.closest('.robot-list-action')) return;
        if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        this.switchAccount(item.dataset.appid);
      };
      item.addEventListener('click', activate);
      item.addEventListener('keydown', activate);
    });
    container.querySelectorAll('[data-action="edit"]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        this.renameAccount(button.dataset.appid);
      });
    });
    container.querySelectorAll('[data-action="delete"]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        this.removeAccount(button.dataset.appid);
      });
    });
  }

  async switchAccount(appid, conversationId = '') {
    try {
      if (appid !== this.getCurrentAccountId()) {
        await accountJson(await fetch(`/api/accounts/${encodeURIComponent(appid)}/switch`, {
          method: 'POST',
        }));
      }
      await Promise.all([this.loadAccounts(), this.getCurrentAccount()]);
      if (typeof currentConv !== 'undefined') currentConv = '';
      if (typeof lastMsgId !== 'undefined') lastMsgId = 0;
      if (typeof refreshConversations === 'function') await refreshConversations(false);
      if (conversationId && typeof selectConv === 'function') {
        await selectConv(conversationId);
      } else if (typeof viewMode !== 'undefined' && viewMode === 'home' && typeof loadHomeStats === 'function') {
        await loadHomeStats();
      } else if (typeof showChatView === 'function') {
        showChatView(true);
      }
      if (typeof showToast === 'function') showToast(`✓ 已切换到 ${this.currentAccount?.bot_name || appid}`);
      return true;
    } catch (error) {
      if (typeof showToast === 'function') showToast(`⚠ ${error.message}`);
      return false;
    }
  }

  async removeAccount(appid) {
    const confirmed = typeof showConfirm === 'function'
      ? await showConfirm('确定删除这个账号吗？账号下的历史消息不会被删除。', 'warning')
      : window.confirm('确定删除这个账号吗？');
    if (!confirmed) return;
    try {
      await accountJson(await fetch(`/api/accounts/${encodeURIComponent(appid)}`, { method: 'DELETE' }));
      this.toggleRobotList(false);
      await this.loadAccounts();
      if (!this.accounts.length) {
        window.location.href = '/login';
        return;
      }
      await this.getCurrentAccount();
      if (typeof refreshConversations === 'function') await refreshConversations(false);
    } catch (error) {
      if (typeof showToast === 'function') showToast(`⚠ ${error.message}`);
    }
  }

  async renameAccount(appid) {
    const account = this.accounts.find(item => item.appid === appid);
    if (!account) return;
    const result = typeof showConfirm === 'function'
      ? await showConfirm(`编辑「${account.bot_name || appid}」的显示名称`, 'settings', false, true, '', '', '', account.bot_name || appid)
      : window.prompt('机器人名称', account.bot_name || appid);
    const nextName = typeof result === 'string' ? result.trim() : (result && result.action ? result.reason.trim() : '');
    if (!nextName || nextName === (account.bot_name || appid)) return;
    try {
      await accountJson(await fetch(`/api/accounts/${encodeURIComponent(appid)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot_name: nextName }),
      }));
      await this.loadAccounts();
      await this.getCurrentAccount();
      if (typeof showToast === 'function') showToast('✓ 机器人名称已更新');
    } catch (error) {
      if (typeof showToast === 'function') showToast(`⚠ ${error.message}`);
    }
  }

  toggleRobotList(show) {
    const panel = document.getElementById('robotListPanel');
    const button = document.getElementById('btnRobotList');
    if (!panel) return;
    const next = show === undefined ? !panel.classList.contains('show') : !!show;
    panel.classList.toggle('show', next);
    panel.setAttribute('aria-hidden', next ? 'false' : 'true');
    if (button) button.setAttribute('aria-expanded', next ? 'true' : 'false');
  }

  bindEvents() {
    if (this.eventsBound) return;
    this.eventsBound = true;
    const avatar = document.getElementById('railBotAvatar');
    const mobileAvatar = document.getElementById('mobileBotAvatar');
    const add = document.getElementById('btnAddAccount');
    const robotList = document.getElementById('btnRobotList');
    const robotListClose = document.getElementById('btnCloseRobotList');
    const robotListAdd = document.getElementById('btnRobotListAdd');
    const modal = document.getElementById('addAccountModal');
    const cancel = document.getElementById('btnCancelAddAccount');
    const form = document.getElementById('addAccountForm');
    if (avatar) avatar.addEventListener('click', () => {
      const primary = this.accounts[0];
      if (primary) this.switchAccount(primary.appid);
    });
    if (mobileAvatar) mobileAvatar.addEventListener('click', () => {
      const active = this.currentAccount || this.accounts[0];
      if (active) this.switchAccount(active.appid);
    });
    if (add) add.addEventListener('click', () => this.showAddAccountModal());
    if (robotList) robotList.addEventListener('click', event => {
      event.stopPropagation();
      this.toggleRobotList();
    });
    if (robotListClose) robotListClose.addEventListener('click', () => this.toggleRobotList(false));
    if (robotListAdd) robotListAdd.addEventListener('click', () => {
      this.toggleRobotList(false);
      this.showAddAccountModal();
    });
    if (cancel) cancel.addEventListener('click', () => this.hideAddAccountModal());
    if (form) form.addEventListener('submit', event => {
      event.preventDefault();
      this.addAccount();
    });
    if (modal) modal.addEventListener('click', event => {
      if (event.target === modal) this.hideAddAccountModal();
    });
    document.addEventListener('click', event => {
      const panel = document.getElementById('robotListPanel');
      const button = document.getElementById('btnRobotList');
      if (panel?.classList.contains('show') && !panel.contains(event.target) && !button?.contains(event.target)) {
        this.toggleRobotList(false);
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        this.hideAddAccountModal();
        this.toggleRobotList(false);
      }
    });
  }

  showAddAccountModal() {
    const modal = document.getElementById('addAccountModal');
    if (!modal) return;
    document.getElementById('addAccountForm')?.reset();
    const error = document.getElementById('addAccountError');
    if (error) error.style.display = 'none';
    modal.classList.add('show');
    setTimeout(() => document.getElementById('newAppid')?.focus(), 80);
  }

  hideAddAccountModal() {
    document.getElementById('addAccountModal')?.classList.remove('show');
  }

  async addAccount() {
    const appid = document.getElementById('newAppid').value.trim();
    const secret = document.getElementById('newSecret').value.trim();
    const error = document.getElementById('addAccountError');
    const submit = document.getElementById('btnSubmitAddAccount');
    error.style.display = 'none';
    if (!appid || !secret) {
      error.textContent = '请输入 AppID 和 AppSecret';
      error.style.display = 'block';
      return;
    }
    submit.disabled = true;
    submit.textContent = '登录中...';
    try {
      await accountJson(await fetch('/api/accounts/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appid, secret }),
      }));
      this.hideAddAccountModal();
      await Promise.all([this.loadAccounts(), this.getCurrentAccount()]);
      if (typeof refreshConversations === 'function') await refreshConversations(false);
      if (typeof loadHomeStats === 'function') await loadHomeStats();
      if (typeof showToast === 'function') showToast('✓ 账号已添加');
    } catch (requestError) {
      error.textContent = requestError.message;
      error.style.display = 'block';
    } finally {
      submit.disabled = false;
      submit.textContent = '登录并添加';
    }
  }
}

const accountManager = new AccountManager();
window.accountManager = accountManager;
