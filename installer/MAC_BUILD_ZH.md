# 万机 (Wanji) macOS 主电脑版构建与使用说明

## 一、在 Mac 上打包安装包（.pkg 与 .dmg）

由于 `.pkg`（`pkgbuild`）、`.dmg`（`hdiutil`）与原生 Swift 编译（`swiftc`）依赖 macOS 系统工具链，请在任意一台 macOS 12.3+ 机器（或 GitHub Actions `macos-15`）上执行：

```bash
# Apple Silicon (M1/M2/M3/M4)
ARCH=arm64 bash installer/build-mac.sh

# Intel Mac
ARCH=x64 bash installer/build-mac.sh
```

脚本会自动下载固定版本的 Node.js (`24.21.0`) 与 `cloudflared` (`2026.10.7`)，编译原生桌面控制助手 `Wanji Desktop Control.app`（纯 Swift，零 Python 依赖）和菜单栏应用 `Wanji.app`，并在 `dist/` 下生成：
- `dist/Wanji-<version>-macOS-<arch>.pkg`（安装 `/Applications/Wanji.app` 与命令行 `/usr/local/bin/wanji`）
- `dist/Wanji-<version>-macOS-<arch>.dmg`（包含 `Wanji.app` 与 `.pkg`）

## 二、首次安装与主电脑配置

1. 双击 `.pkg` 完成安装，或在「应用程序」中打开 **万机 Wanji**。
2. 设为主电脑（绑定自己的 Cloudflare 域名）：
   ```bash
   wanji setup <电脑名> --domain <你的域名>
   ```
   连接手机 App：
   ```bash
   wanji app
   ```
3. 授权桌面控制权限（无需安装 Python）：
   - 在 **系统设置 -> 隐私与安全性** 中为 **Wanji Desktop Control** 勾选 **辅助功能 (Accessibility)** 与 **屏幕录制 (Screen Recording)**。
   - 授权完成后重启服务使其生效：
     ```bash
     wanji stop && wanji start
     ```
