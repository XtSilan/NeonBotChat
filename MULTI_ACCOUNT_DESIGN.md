# NeonBotChat 多账号登录功能设计文档

## 1. 概述

### 1.1 目标
实现多账号登录和管理功能，允许用户：
- 登录页面选择已保存的账号或输入新的 AppID/Secret 登录
- 左上角机器人头像下方添加"添加账号"图标
- 点击后弹出浮窗，填入新账号的 AppID 和 Secret
- 主页统计支持选择单个账号或全部账号进行统计
- 新消息提醒：播放提示音 + 头像旁弹出气泡显示发送者信息（3秒后自动收回）

### 1.2 核心功能
1. **多账号登录**：支持保存和切换多个 QQ Bot 账号
2. **账号管理**：添加、删除、切换账号
3. **消息通知**：新消息气泡提醒动画
4. **统计增强**：支持按账号过滤统计数据

## 2. 技术架构

### 2.1 数据库改造

#### 2.1.1 新增 accounts 表
```sql
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,           -- 账号ID (appid)
    name TEXT NOT NULL DEFAULT '', -- 显示名称（自动从QQ API获取）
    appid TEXT NOT NULL UNIQUE,
    secret TEXT NOT NULL,
    bot_name TEXT DEFAULT '',
    bot_avatar TEXT DEFAULT '',
    enabled INTEGER DEFAULT 1,
    last_login REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
);
```

#### 2.1.2 修改 conversations 表
```sql
ALTER TABLE conversations ADD COLUMN account_id TEXT DEFAULT '';
CREATE INDEX idx_conv_account ON conversations(account_id);
```

#### 2.1.3 修改 messages 表
```sql
ALTER TABLE messages ADD COLUMN account_id TEXT DEFAULT '';
CREATE INDEX idx_msg_account ON messages(account_id);
```

### 2.2 后端架构改造

#### 2.2.1 新增 bot_manager.py
```python
class BotManager:
    """管理多个 Bot 实例"""
    def __init__(self):
        self.bots = {}  # appid -> BotInstance
        self.active_bot = None  # 当前活跃的 bot
    
    async def login_bot(self, appid, secret):
        """登录单个 bot"""
        pass
    
    async def logout_bot(self, appid):
        """登出单个 bot"""
        pass
    
    def get_active_bot(self):
        """获取当前活跃的 bot"""
        pass
    
    def get_all_bots(self):
        """获取所有 bot"""
        pass
```

#### 2.2.2 修改 web_server.py
新增 API 接口：
```python
@app.post("/api/accounts/login")
async def api_login_account(request: Request):
    """登录账号（验证 AppID/Secret）"""
    pass

@app.get("/api/accounts")
async def api_get_accounts():
    """获取所有已保存的账号"""
    pass

@app.delete("/api/accounts/{appid}")
async def api_delete_account(appid: str):
    """删除账号"""
    pass

@app.post("/api/accounts/{appid}/switch")
async def api_switch_account(appid: str):
    """切换当前账号"""
    pass

@app.get("/api/accounts/current")
async def api_get_current_account():
    """获取当前账号信息"""
    pass

@app.get("/api/stats/multi")
async def api_get_multi_stats(account_id: str = "all"):
    """获取统计数据（支持按账号过滤）"""
    pass
```

### 2.3 前端架构改造

#### 2.3.1 新增文件
- `web/js/accounts.js` - 账号管理逻辑
- `web/js/notifications.js` - 消息通知逻辑
- `web/css/accounts.css` - 账号相关样式

#### 2.3.2 修改文件
- `web/index.html` - 添加登录页面和账号管理UI
- `web/js/core.js` - 集成账号切换逻辑
- `web/css/components.css` - 添加通知气泡样式

## 3. UI 设计

### 3.1 登录页面

#### 3.1.1 页面结构
```html
<div id="loginPage" class="login-page">
  <div class="login-container">
    <div class="login-logo">
      <img src="icons/bot.svg" alt="NeonBotChat">
      <h1>NeonBotChat</h1>
    </div>
    
    <!-- 已保存账号列表 -->
    <div class="saved-accounts" id="savedAccounts">
      <h3>选择账号登录</h3>
      <div class="account-list" id="accountList">
        <!-- 动态生成 -->
      </div>
    </div>
    
    <!-- 分隔线 -->
    <div class="divider">
      <span>或输入新账号</span>
    </div>
    
    <!-- 登录表单 -->
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
```

#### 3.1.2 样式设计
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

.saved-accounts {
  margin-bottom: 20px;
}

.account-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s;
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
```

### 3.2 侧边栏账号区域

#### 3.2.1 HTML 结构
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

#### 3.2.2 账号切换下拉样式
```css
.account-switcher {
  position: absolute;
  left: 60px;
  top: 100px;
  background: var(--surface);
  border-radius: 12px;
  padding: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  z-index: 100;
  min-width: 200px;
}

.account-switch-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s;
}

.account-switch-item:hover {
  background: var(--hover);
}

.account-switch-item.active {
  background: var(--accent-bg);
  border: 1px solid var(--accent);
}

.account-switch-item .avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--accent);
}

.account-switch-item .info {
  flex: 1;
}

.account-switch-item .name {
  font-weight: 600;
  font-size: 0.9em;
}

.account-switch-item .status {
  font-size: 0.75em;
  color: var(--text-dim);
}

.account-switch-item .remove-btn {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--danger);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.2s;
}

.account-switch-item:hover .remove-btn {
  opacity: 1;
}
```

### 3.3 添加账号浮窗

#### 3.3.1 HTML 结构
```html
<div class="modal-overlay" id="addAccountModal">
  <div class="modal-box" style="width:380px;">
    <h3>
      <img src="icons/add.svg" class="svg-icon" style="width:18px;height:18px;" alt="">
      添加新账号
    </h3>
    <form id="addAccountForm">
      <div class="form-group">
        <label for="newAppid">AppID</label>
        <input type="text" id="newAppid" placeholder="输入 QQ Bot AppID" required>
      </div>
      <div class="form-group">
        <label for="newSecret">AppSecret</label>
        <input type="password" id="newSecret" placeholder="输入 AppSecret" required>
      </div>
      <div id="addAccountError" class="error-message" style="display:none;"></div>
      <div class="modal-actions">
        <button type="button" class="btn-cancel" id="btnCancelAddAccount">取消</button>
        <button type="submit" class="glass-btn active">登录</button>
      </div>
    </form>
  </div>
</div>
```

### 3.4 消息通知气泡

#### 3.4.1 HTML 结构
```html
<div class="notification-container" id="notificationContainer">
  <!-- 动态生成通知气泡 -->
</div>
```

#### 3.4.2 通知气泡样式
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

### 3.5 主页统计增强

#### 3.5.1 账号过滤器
```html
<div class="stats-filter">
  <label>统计账号：</label>
  <select id="statsAccountFilter">
    <option value="all">全部账号</option>
    <!-- 动态生成账号选项 -->
  </select>
</div>
```

## 4. 功能实现

### 4.1 登录流程

#### 4.1.1 首次登录
1. 用户访问 WebUI，显示登录页面
2. 用户输入 AppID 和 Secret
3. 前端调用 `/api/accounts/login` 验证
4. 验证成功后，保存账号信息到数据库
5. 启动 Bot 实例
6. 跳转到主界面

#### 4.1.2 已有账号登录
1. 用户访问 WebUI，显示登录页面
2. 页面显示已保存的账号列表
3. 用户点击账号头像
4. 前端调用 `/api/accounts/{appid}/switch`
5. 启动对应的 Bot 实例
6. 跳转到主界面

### 4.2 账号管理

#### 4.2.1 添加账号
1. 点击侧边栏"添加账号"按钮
2. 弹出添加账号浮窗
3. 输入 AppID 和 Secret
4. 前端调用 `/api/accounts/login` 验证并保存
5. 成功后自动切换到新账号

#### 4.2.2 切换账号
1. 点击侧边栏当前账号头像
2. 显示账号切换下拉菜单
3. 选择要切换的账号
4. 前端调用 `/api/accounts/{appid}/switch`
5. 重新加载会话列表和消息

#### 4.2.3 删除账号
1. 在账号切换下拉菜单中，悬停显示删除按钮
2. 点击删除按钮
3. 弹出确认对话框
4. 确认后调用 `/api/accounts/{appid}`
5. 如果删除的是当前账号，自动切换到其他账号

### 4.3 消息通知

#### 4.3.1 通知触发条件
- 收到新消息
- 不是当前正在查看的会话
- 不是当前活跃的账号（可选）

#### 4.3.2 通知流程
1. 收到 WebSocket 消息
2. 检查是否需要通知
3. 播放提示音
4. 创建通知气泡
5. 显示发送者头像、昵称和消息预览
6. 3秒后自动隐藏（带滑出动画）

#### 4.3.3 提示音实现
```javascript
function playNotificationSound() {
  const audio = new Audio('/sounds/notification.mp3');
  audio.volume = 0.5;
  audio.play().catch(e => console.log('播放提示音失败:', e));
}
```

### 4.4 统计功能

#### 4.4.1 数据查询
```python
@app.get("/api/stats/multi")
async def api_get_multi_stats(account_id: str = "all"):
    """获取统计数据（支持按账号过滤）"""
    if account_id == "all":
        # 查询所有账号的统计数据
        stats = await get_stats_all_accounts()
    else:
        # 查询指定账号的统计数据
        stats = await get_stats_by_account(account_id)
    return stats
```

#### 4.4.2 前端过滤
```javascript
async function loadStats(accountId = 'all') {
  const resp = await API(`/api/stats/multi?account_id=${accountId}`);
  renderStats(resp);
}

// 监听过滤器变化
document.getElementById('statsAccountFilter').addEventListener('change', (e) => {
  loadStats(e.target.value);
});
```

## 5. 实现步骤

### 5.1 阶段一：数据库改造
1. 修改 `database.py`，添加 accounts 表
2. 修改 conversations 和 messages 表，增加 account_id 字段
3. 添加数据迁移脚本
4. 修改相关查询函数，支持 account_id 过滤

### 5.2 阶段二：后端改造
1. 创建 `bot_manager.py`，管理多个 Bot 实例
2. 修改 `init.py`，支持多账号启动
3. 修改 `web_server.py`，添加账号管理 API
4. 修改消息发送函数，支持指定账号

### 5.3 阶段三：前端改造
1. 创建登录页面 (`login.html`)
2. 修改 `index.html`，添加账号管理 UI
3. 创建 `accounts.js`，实现账号管理逻辑
4. 创建 `notifications.js`，实现消息通知
5. 添加相关 CSS 样式

### 5.4 阶段四：测试与优化
1. 测试多账号登录流程
2. 测试账号切换功能
3. 测试消息通知效果
4. 测试统计过滤功能
5. 优化性能和用户体验

## 6. 注意事项

### 6.1 安全性
- AppSecret 需要加密存储
- 登录状态使用 Session 或 JWT
- 防止 CSRF 攻击

### 6.2 性能
- 多个 Bot 实例会占用更多内存
- 合理管理 WebSocket 连接
- 使用懒加载减少初始加载时间

### 6.3 用户体验
- 登录状态持久化
- 平滑的切换动画
- 清晰的错误提示
- 响应式设计适配移动端

### 6.4 兼容性
- 保持现有功能不受影响
- 支持从单账号平滑升级
- 向后兼容旧版本数据

## 7. 文件清单

### 7.1 新增文件
- `web/login.html` - 登录页面
- `web/js/accounts.js` - 账号管理逻辑
- `web/js/notifications.js` - 消息通知逻辑
- `web/css/accounts.css` - 账号相关样式
- `web/sounds/notification.mp3` - 提示音文件
- `bot_manager.py` - Bot 实例管理器

### 7.2 修改文件
- `database.py` - 数据库结构改造
- `web_server.py` - 添加账号管理 API
- `init.py` - 支持多账号启动
- `web/index.html` - 添加账号管理 UI
- `web/js/core.js` - 集成账号切换逻辑
- `web/css/components.css` - 添加通知气泡样式

### 7.3 配置文件
- `config.yaml` - 可选：添加默认账号配置

## 8. 示例代码

### 8.1 账号管理器
```python
# bot_manager.py
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
        # 验证 AppID/Secret
        # 启动 Bot 实例
        # 保存到数据库
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

# 全局实例
bot_manager = BotManager()
```

### 8.2 前端账号管理
```javascript
// accounts.js
class AccountManager {
  constructor() {
    this.accounts = [];
    this.currentAccount = null;
  }
  
  async loadAccounts() {
    const resp = await API('/api/accounts');
    this.accounts = resp.accounts || [];
    this.renderAccountList();
  }
  
  async login(appid, secret) {
    const resp = await API('/api/accounts/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appid, secret })
    });
    if (resp.ok) {
      await this.loadAccounts();
      return true;
    }
    return false;
  }
  
  async switchAccount(appid) {
    const resp = await API(`/api/accounts/${appid}/switch`, {
      method: 'POST'
    });
    if (resp.ok) {
      this.currentAccount = this.accounts.find(a => a.appid === appid);
      // 重新加载数据
      await loadConversations();
      await loadStats();
    }
  }
  
  renderAccountList() {
    // 渲染账号列表
  }
}

const accountManager = new AccountManager();
```

### 8.3 消息通知
```javascript
// notifications.js
class NotificationManager {
  constructor() {
    this.container = document.getElementById('notificationContainer');
    this.audio = new Audio('/sounds/notification.mp3');
    this.audio.volume = 0.5;
  }
  
  show(accountName, senderName, message, avatar) {
    // 播放提示音
    this.audio.play().catch(() => {});
    
    // 创建气泡
    const bubble = document.createElement('div');
    bubble.className = 'notification-bubble';
    bubble.innerHTML = `
      <div class="avatar">
        ${avatar ? `<img src="${avatar}" style="width:100%;height:100%;border-radius:50%;">` : senderName[0]}
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
}

const notificationManager = new NotificationManager();
```

## 9. 待办事项

- [ ] 设计登录页面 UI
- [ ] 实现账号管理后端 API
- [ ] 实现 Bot 管理器
- [ ] 添加消息通知功能
- [ ] 修改统计页面支持多账号
- [ ] 测试多账号切换
- [ ] 优化性能
- [ ] 编写用户文档

---

**文档版本**: v1.0  
**创建日期**: 2026-09-18  
**作者**: NeonBotChat Team
