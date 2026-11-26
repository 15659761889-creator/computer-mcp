# 万机 (Wanji) macOS 主电脑版构建与使用说明

## 一、在 Mac 上打包安装包（.pkg 与 .dmg）

由于 `.pkg`（`pkgbuild`）、`.dmg`（`hdiutil`）与原生 Swift 编译（`swiftc`）依赖 macOS 系统工具链，构建机需要安装 Xcode Command Line Tools。最终安装包会预置编译好的 helper，普通用户的 Mac 不需要安装这些开发工具。请在 macOS 12.3+ 构建机（或 GitHub Actions `macos-15` / `macos-15-intel`）上执行：

```bash
# Apple Silicon (M1/M2/M3/M4)
ARCH=arm64 bash installer/build-mac.sh

# Intel Mac
ARCH=x64 bash installer/build-mac.sh
```

脚本会自动下载固定版本的 Node.js (`24.21.0`) 与 `cloudflared` (`2026.10.7`)，编译原生桌面控制助手 `Wanji Desktop Control.app`（纯 Swift，零 Python 依赖）和菜单栏应用 `Wanji.app`，并在 `dist/` 下生成：
- `dist/Wanji-<version>-macOS-<arch>.pkg`（安装 `/Applications/Wanji.app` 与命令行 `/usr/local/bin/wanji`）
- `dist/Wanji-<version>-macOS-<arch>.dmg`（包含 `Wanji.app` 与 `.pkg`）

## 二、首次安装与图形化配对

1. 双击 `.pkg` 完成安装，然后从「应用程序」打开 **万机 Wanji**。
2. 在「首次配置向导」中选择一种方式：
   - **设置为主电脑**：填写电脑名称和你自己管理的 Cloudflare 域名，点击「设置为主电脑」。首次使用 Cloudflare 时会打开浏览器，请登录并批准域名访问。授权完成后，服务会自动配置并启动。
   - **加入已有主电脑**：在主电脑的万机窗口点击「生成加入码并复制」，再把加入码发给新电脑；新电脑粘贴后点击「加入已有主电脑」。加入码 10 分钟有效且只能使用一次。
3. 主电脑连接手机：在菜单栏打开万机菜单，点击「手机扫码连接 (wanji app)」，用手机扫描二维码。
4. 授权桌面控制（无需 Python，也无需在用户电脑上安装 Xcode Command Line Tools）：
   - 在 **系统设置 -> 隐私与安全性 -> 辅助功能** 中允许 **Wanji Desktop Control**。
   - 在 **系统设置 -> 隐私与安全性 -> 屏幕与系统音频录制** 中允许 **Wanji Desktop Control**。
   - 首次执行鼠标键盘控制时，按 macOS 提示允许输入监控 / 发送事件权限。
   - 回到万机菜单栏，状态会查询原生 helper 自身的授权情况；授权后点击「停止服务」再「启动服务」使权限重新生效。

macOS 12.3–15.1 的旧版截屏 API 目前只支持主显示器；macOS 15.2 及以上版本使用 ScreenCaptureKit，可读取多显示器桌面。

## 三、签名与首次打开提示

本机开发构建默认使用 ad-hoc 签名，不能代替 Apple Developer ID 正式签名，也不会自动完成 Apple 公证。公开分发前需要配置：
- `APPLE_APPLICATION_SIGNING_IDENTITY`：Developer ID Application 证书，用于签署 Wanji.app 和原生桌面 helper。
- `APPLE_INSTALLER_SIGNING_IDENTITY`：Developer ID Installer 证书，用于签署 `.pkg`。
- `APPLE_NOTARY_PROFILE`：已通过 `xcrun notarytool store-credentials` 保存到构建 Mac 钥匙串的公证配置名称。

未配置这些凭据时，CI 仍可生成用于测试的安装包，但首次打开可能被 Gatekeeper 警告或拦截。不要把证书、私钥或公证密码写进仓库。
