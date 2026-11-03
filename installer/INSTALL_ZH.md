# Computer MCP Windows EXE 安装说明

适用系统：Windows 10/11 x64。此安装包无需预装 Node.js 或 npm。

## 普通用户
1. 双击 `ComputerMCP-Setup-0.4.0-x64.exe` 完成安装。
2. 打开开始菜单里的 **Computer MCP**。
3. 点击 **启动临时连接**，确认远程控制安全提醒。此模式无需域名或 Cloudflare 账号，但需要网络连接。
4. 连接成功后选择 **复制完整链接**，粘贴到支持远程 HTTP MCP 的 AI 客户端；如果客户端单独要求 URL 与 Token，分别点击 **复制 MCP 地址**、**复制密钥**，并选择 Bearer Token 认证。
5. **不要公开分享完整链接或密钥**，它们具备电脑远程控制权限。
6. 桌面鼠标键盘与 OCR 功能需点击 **安装桌面控制 / OCR** 下载 Python、依赖和模型。此步骤依赖网络以及 Windows Package Manager（winget），可能要求额外磁盘空间；未安装前，文件和命令行功能仍可使用。
7. 固定域名需要自己管理的 Cloudflare 域名；不要使用别人提供的域名当作自己的。

## 特别说明
- 安装包已内置 Node.js 和 Cloudflare Tunnel 运行程序；不是只有一个会调用外部 Node 的启动器。
- 安装向导为英文，启动后的 Windows 管理界面为中文。
- 安装包目前没有开发者代码签名，Windows SmartScreen 可能显示提示。公开推广前建议购买/申请可信发布者签名并进行多机测试。
- 电脑锁屏、UAC 安全桌面、部分受保护软件可能无法使用鼠标和截图控制。
- 卸载程序只移除这套程序文件，不会主动终止或删除已有隧道服务、用户密钥和个人项目。卸载前应自行停止由本程序启动的连接。
- 首次推广给朋友前，建议在另一台干净的 Windows 电脑做一次完整安装、连接、OCR 下载验收。

## 开发者重新打包
在 Windows 开发机安装 Inno Setup 6，并准备可信的 node.exe、cloudflared.exe：
```powershell
powershell -ExecutionPolicy Bypass -File installer\build.ps1 -CloudflaredPath 'C:\path\to\cloudflared.exe'
```

输出位于 `build\windows\dist\ComputerMCP-Setup-0.4.0-x64.exe`。
