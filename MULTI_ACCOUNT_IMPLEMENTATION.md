# NeonBotChat 多账号登录功能实现指南

## 快速开始

### 1. 数据库改造

修改 `database.py`，在 `init_db()` 函数中添加：

```python
# 新增 accounts 表
conn.executescript("""
    CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        appid TEXT NOT NULL UNIQUE,
        secret TEXT NOT NULL,
        bot_name TEXT DEFAULT '',
        bot_avatar TEXT DEFAULT '',
        enabled INTEGER DEFAULT 1,
        last_login REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
""")

# 修改 conversations 表
cols = {r[1] for r in conn.execute("PRAGMA table_info(conversations)").fetchall()}
if "account_id" not in cols:
    conn.execute("ALTER TABLE conversations ADD COLUMN account_id TEXT DEFAULT ''")
    conn.execute("CREATE INDEX idx_conv_account ON conversations(account_id)")

# 修改 messages 表
cols = {r[1] for r in conn.execute("PRAGMA table_info(messages)").fetchall()}
if "account_id" not in cols:
    conn.execute("ALTER TABLE messages ADD COLUMN account_id TEXT DEFAULT ''")
    conn.execute("CREATE INDEX idx_msg_account ON messages(account_id)")
```

### 2. 创建 Bot 管理器

新建 `bot_manager.py`：

```python
import asyncio
from typing import Dict, Optional
from dataclasses import dataclass
from datetime import datetime

@dataclass
class BotInstance:
    appid: str
    secret: str
    bot_name: str = ""
    bot_avatar: str = ""
    is_running: bool = False
    start_time: Optional[datetime] = None

class BotManager:
    def __init__(self):
        self.bots: Dict[str, BotInstance] = {}
        self.active_appid: Optional[str] = None
    
    async def login(self, appid: str, secret: str) -> dict:
        """登录并启动 Bot"""
        # 1. 验证 AppID/Secret
        # 2. 启动 Bot 实例
        # 3. 保存到数据库
        pass
    
    async def logout(self, appid: str):
        """登出 Bot"""
        pass
    
    def switch(self, appid: str):
        """切换当前账号"""
        pass
    
    def get_active(self) -> Optional[BotInstance]:
        """获取当前活跃的 Bot"""
        pass

bot_manager = BotManager()
```

### 3. 添加后端 API

修改 `web_server.py`，添加以下 API：

```python
@app.post("/api/accounts/login")
async def api_login_account(request: Request):
    """登录账号"""
    try:
        body = await request.json()
        appid = body.get("appid", "").strip()
        secret = body.get("secret", "").strip()
        
        if not appid or not secret:
            return JSONResponse({"error": "AppID 和 Secret 不能为空"}, status_code=400)
        
        # 验证并登录
        result = await bot_manager.login(appid, secret)
        
        if result.get("ok"):
            return {"ok": True, "account": result.get("account")}
        else:
            return JSONResponse({"error": result.get("error", "登录失败")}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

@app.get("/api/accounts")
async def api_get_accounts():
    """获取所有账号"""
    accounts = await get_all_accounts()
    return {"accounts": accounts}

@app.delete("/api/accounts/{appid}")
async def api_delete_account(appid: str):
    """删除账号"""
    await delete_account(appid)
    return {"ok": True}

@app.post("/api/accounts/{appid}/switch")
async def api_switch_account(appid: str):
    """切换账号"""
    result = await bot_manager.switch(appid)
    return {"ok": True}

@app.get("/api/accounts/current")
async def api_get_current_account():
    """获取当前账号"""
    account = bot_manager.get_active()
    return {"account": account}
```

### 4. 创建登录页面

新建 `web/login.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NeonBotChat - 登录</title>
  <link rel="stylesheet" href="css/base.css">
  <link rel="stylesheet" href="css/accounts.css">
</head>
<body>
  <div id="loginPage" class="login-page">
    <div class="login-container">
      <div class="login-logo">
        <img src="icons/bot.svg" alt="NeonBotChat">
        <h1>NeonBotChat</h1>
      </div>
      
      <div class="saved-accounts" id="savedAccounts">
        <h3>选择账号登录</h3>
        <div class="account-list" id="accountList"></div>
      </div>
      
      <div class="divider"><span>或输入新账号</span></div>
      
      <form class="login-form" id="loginForm">
        <div class="form-group">
          <label for="loginAppid">AppID</label>
          <input type="text" id="loginAppid" placeholder="输入 AppID" required>
        </div>
        <div class="form-group">
          <label for="loginSecret">AppSecret</label>
          <input type="password" id="loginSecret" placeholder="输入 AppSecret" required>
        </div>
        <div class="form-actions">
          <label class="remember-me">
            <input type="checkbox" id="rememberAccount" checked>
            <span>保存账号</span>
          </label>
          <button type="submit" class="btn-login">登录</button>
        </div>
      </form>
    </div>
  </div>
  
  <script src="js/accounts.js"></script>
  <script>
    const loginManager = new LoginManager();
    loginManager.init();
  </script>
</body>
</html>
```

### 5. 创建账号管理 JS

新建 `web/js/accounts.js`：

```javascript
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
      }
    } catch (e) {
      console.error('登录失败:', e);
    }
  }
  
  bindEvents() {
    const form = document.getElementById('loginForm');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.loginWithNew();
    });
  }
  
  async loginWithNew() {
    const appid = document.getElementById('loginAppid').value.trim();
    const secret = document.getElementById('loginSecret').value.trim();
    
    if (!appid || !secret) {
      alert('请输入 AppID 和 Secret');
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
        window.location.href = '/';
      } else {
        alert(data.error || '登录失败');
      }
    } catch (e) {
      alert('网络错误: ' + e.message);
    }
  }
}
```

### 6. 创建账号管理样式

新建 `web/css/accounts.css`：

```css
.login-page {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.login-container {
  width: 400px;
  max-width: 90vw;
  background: var(--surface);
  border-radius: 16px;
  padding: 32px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}

.login-logo {
  text-align: center;
  margin-bottom: 24px;
}

.login-logo img {
  width: 48px;
  height: 48px;
}

.login-logo h1 {
  margin-top: 8px;
  font-size: 1.5em;
}

.saved-accounts {
  margin-bottom: 20px;
}

.saved-accounts h3 {
  font-size: 0.9em;
  color: var(--text-dim);
  margin-bottom: 12px;
}

.account-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.account-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s;
  background: var(--bg);
}

.account-item:hover {
  background: var(--hover);
}

.account-item .avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  color: white;
}

.account-item .info {
  flex: 1;
}

.account-item .name {
  font-weight: 600;
}

.account-item .appid {
  font-size: 0.85em;
  color: var(--text-dim);
}

.no-accounts {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.9em;
  padding: 20px;
}

.divider {
  text-align: center;
  margin: 20px 0;
  position: relative;
}

.divider::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--border);
}

.divider span {
  background: var(--surface);
  padding: 0 12px;
  position: relative;
  color: var(--text-dim);
  font-size: 0.85em;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group label {
  font-size: 0.9em;
  font-weight: 600;
}

.form-group input {
  padding: 10px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 0.95em;
  outline: none;
  transition: border-color 0.2s;
}

.form-group input:focus {
  border-color: var(--accent);
}

.form-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.remember-me {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.9em;
  cursor: pointer;
}

.remember-me input {
  width: 16px;
  height: 16px;
}

.btn-login {
  padding: 10px 24px;
  border-radius: 8px;
  border: none;
  background: var(--accent);
  color: white;
  font-size: 1em;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}

.btn-login:hover {
  background: var(--accent-hover);
}

/* 添加账号浮窗 */
.modal-box h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}

.error-message {
  color: var(--danger);
  font-size: 0.85em;
  margin-top: 8px;
}
```

### 7. 创建消息通知

新建 `web/js/notifications.js`：

```javascript
class NotificationManager {
  constructor() {
    this.container = null;
    this.audio = null;
    this.init();
  }
  
  init() {
    // 创建容器
    this.container = document.createElement('div');
    this.container.className = 'notification-container';
    document.body.appendChild(this.container);
    
    // 加载提示音
    this.audio = new Audio('/sounds/notification.mp3');
    this.audio.volume = 0.5;
  }
  
  show(accountName, senderName, message, avatar) {
    // 播放提示音
    this.playSound();
    
    // 创建气泡
    const bubble = document.createElement('div');
    bubble.className = 'notification-bubble';
    bubble.innerHTML = `
      <div class="avatar">
        ${avatar 
          ? `<img src="${avatar}" style="width:100%;height:100%;border-radius:50%;">` 
          : senderName[0]}
      </div>
      <div class="content">
        <div class="account-name">${accountName}</div>
        <div class="sender-name">${senderName}</div>
        <div class="message-preview">${message}</div>
      </div>
    `;
    
    this.container.appendChild(bubble);
    
    // 3秒后自动隐藏
    setTimeout(() => {
      bubble.classList.add('hiding');
      setTimeout(() => bubble.remove(), 300);
    }, 3000);
  }
  
  playSound() {
    this.audio.currentTime = 0;
    this.audio.play().catch(e => console.log('播放提示音失败:', e));
  }
}

// 全局实例
const notificationManager = new NotificationManager();
```

### 8. 添加通知样式

在 `web/css/components.css` 中添加：

```css
.notification-container {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.notification-bubble {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--surface);
  border-radius: 12px;
  padding: 12px 16px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  animation: slideIn 0.3s ease-out;
  max-width: 320px;
}

.notification-bubble.hiding {
  animation: slideOut 0.3s ease-in forwards;
}

.notification-bubble .avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.notification-bubble .content {
  flex: 1;
  min-width: 0;
}

.notification-bubble .account-name {
  font-size: 0.75em;
  color: var(--accent);
  margin-bottom: 4px;
}

.notification-bubble .sender-name {
  font-weight: 600;
  font-size: 0.9em;
  margin-bottom: 2px;
}

.notification-bubble .message-preview {
  font-size: 0.85em;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@keyframes slideIn {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@keyframes slideOut {
  from {
    transform: translateX(0);
    opacity: 1;
  }
  to {
    transform: translateX(100%);
    opacity: 0;
  }
}
```

### 9. 修改主页面

在 `web/index.html` 的 `<body>` 开始处添加：

```html
<!-- 登录页面 -->
<div id="loginPage" class="login-page" style="display:none;">
  <!-- 登录页面内容 -->
</div>

<!-- 通知容器 -->
<div class="notification-container" id="notificationContainer"></div>
```

在侧边栏添加账号管理按钮：

```html
<aside class="side-rail">
  <div style="display:flex;flex-direction:column;align-items:center;">
    <!-- Logo -->
    <div id="railLogo">...</div>
    
    <!-- 当前账号头像 -->
    <div style="position:relative;width:40px;height:40px;margin-top:14px;">
      <div id="railBotAvatar">...</div>
      <span id="railStatusDot">...</span>
    </div>
    
    <!-- 添加账号按钮 -->
    <button class="rail-btn" id="btnAddAccount" title="添加账号" 
            style="margin-top:8px;width:24px;height:24px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;">
      <img src="icons/add.svg" class="svg-icon" style="width:14px;height:14px;" alt="">
    </button>
    
    <!-- 账号切换下拉 -->
    <div class="account-switcher" id="accountSwitcher" style="display:none;">
      <!-- 动态生成 -->
    </div>
    
    <!-- 导航按钮 -->
    <div style="display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:16px;">
      <button class="rail-btn" id="railHomeBtn">...</button>
      <button class="rail-btn" id="railMsgBtn">...</button>
    </div>
  </div>
</aside>
```

### 10. 添加提示音文件

在 `web/sounds/` 目录下添加 `notification.mp3` 文件。

## 运行测试

1. 启动后端服务：
```bash
python init.py
```

2. 访问 WebUI：
```
http://localhost:8080
```

3. 测试登录流程：
   - 输入 AppID 和 Secret 登录
   - 保存账号后，刷新页面查看已保存账号列表
   - 点击账号头像快速登录

4. 测试账号管理：
   - 点击"添加账号"按钮
   - 输入新的 AppID 和 Secret
   - 切换账号

5. 测试消息通知：
   - 发送消息到其他账号
   - 观察通知气泡和提示音

## 注意事项

1. **安全性**：AppSecret 需要加密存储（生产环境）
2. **性能**：多个 Bot 实例会占用更多内存
3. **兼容性**：保持现有功能不受影响
4. **错误处理**：添加完善的错误处理和用户提示

## 后续优化

1. 添加账号编辑功能
2. 支持账号排序
3. 添加账号搜索
4. 优化移动端适配
5. 添加账号导入/导出功能

---

**文档版本**: v1.0  
**创建日期**: 2026-09-18
