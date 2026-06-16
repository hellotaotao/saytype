# Releasing

**English** · [中文说明 ↓](#发布中文)

SayType ships as a macOS `.dmg` published to the project's
[GitHub Releases](https://github.com/hellotaotao/WhispLine/releases) page. The
installer is built automatically by the
[`Release`](.github/workflows/release.yml) GitHub Actions workflow — you never
build or upload it by hand.

## What the workflow does

Pushing a tag shaped like `vX.Y.Z` triggers the workflow, which:

1. Spins up a clean macOS runner.
2. Builds a **universal** binary (Intel + Apple Silicon) via
   `tauri build --target universal-apple-darwin`.
3. Signs it with your Developer ID and notarizes it with Apple — **if** the
   signing secrets are configured (see [below](#one-time-setup-signing--notarization)).
4. Creates a **draft** GitHub Release named after the tag and uploads the `.dmg`
   as an asset.

You then review the draft on the Releases page and click **Publish**. (To skip
the manual publish step, set `releaseDraft: false` in the workflow.)

> The workflow only runs on `v*` tag pushes — ordinary commits never trigger it,
> so the file sits dormant until you cut a release.

## Cutting a release

The version shown in the main window and Settings is compiled from `Cargo.toml`
through `env!("CARGO_PKG_VERSION")`, so the version must live in the committed
files and the tag simply mirrors it.

```bash
npm run version:tauri:patch              # bump 1.0.x -> 1.0.(x+1) in package.json, tauri.conf.json, Cargo.toml
git commit -am "chore: release v1.0.90"  # commit the version bump
git tag v1.0.90 && git push origin v1.0.90
```

Then watch the **Actions** tab. The first run takes ~15–25 min (two
architectures plus the notarization queue); later runs are faster thanks to the
Rust cache.

> Don't run `npm run build:mac` to cut a release — it bumps the version a second
> time and produces an unsigned local build. Releasing is just
> bump → commit → tag → push.

## One-time setup: signing & notarization

Without these secrets the workflow still **succeeds**, but the `.dmg` is
**unsigned**: downloaders hit a Gatekeeper warning and must right-click → Open
(or run `xattr -cr /Applications/SayType.app`). To produce an installer that
opens cleanly, add the secrets below under
**Settings → Secrets and variables → Actions → New repository secret**.

Requires a paid Apple Developer account and a **Developer ID Application**
certificate.

| Secret | How to get it |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | The full `Developer ID Application: Name (TEAMID)` string from `security find-identity -v -p codesigning` |
| `APPLE_TEAM_ID` | The 10-character ID in the parentheses above (also on your [Membership page](https://developer.apple.com/account#MembershipDetailsCard)) |
| `APPLE_CERTIFICATE` | Base64 of the exported `.p12` (see below) |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12` |
| `APPLE_ID` | Your Apple Developer account email |
| `APPLE_PASSWORD` | An [app-specific password](https://appleid.apple.com) (Sign-In and Security → App-Specific Passwords) — **not** your login password |

**Exporting the certificate:** In Keychain Access → *login* keychain →
*My Certificates*, find the `Developer ID Application` entry (expand it to
confirm it has a private key), right-click → Export as `.p12` with a password,
then copy its base64 to the clipboard:

```bash
base64 -i ~/Desktop/certificate.p12 | pbcopy   # paste into APPLE_CERTIFICATE
```

If `security find-identity` shows no `Developer ID Application` certificate,
create one at
[developer.apple.com](https://developer.apple.com/account/resources/certificates/list)
(Certificates → ➕ → Developer ID Application), download the `.cer`, and
double-click to install it before exporting.

`tauri.conf.json` keeps `signingIdentity: null` on purpose — in CI the
`APPLE_SIGNING_IDENTITY` environment variable takes over, so local builds are
unaffected.

---

<a id="发布中文"></a>

# 发布(中文)

[↑ English](#releasing)

SayType 以 macOS `.dmg` 的形式发布到项目的
[GitHub Releases](https://github.com/hellotaotao/WhispLine/releases) 页面。安装包由
[`Release`](.github/workflows/release.yml) GitHub Actions workflow 自动构建——你不需要
手动构建或上传。

## workflow 做了什么

推送形如 `vX.Y.Z` 的 tag 会触发该 workflow,它会:

1. 启动一台干净的 macOS runner。
2. 通过 `tauri build --target universal-apple-darwin` 构建**通用**二进制
   (Intel + Apple Silicon)。
3. 用你的 Developer ID 签名并向 Apple 公证——**前提是**配置了签名 secrets
   (见[下文](#一次性配置签名与公证))。
4. 创建一个以该 tag 命名的 **草稿** GitHub Release,并把 `.dmg` 作为附件上传。

随后你在 Releases 页面检查该草稿并点击 **Publish**。(若想跳过手动发布这一步,把
workflow 里的 `releaseDraft` 设为 `false`。)

> 该 workflow 只在推送 `v*` tag 时运行——普通提交不会触发,所以平时它一直休眠,直到你
> 发版。

## 发布一个版本

主窗口和「设置」中显示的版本号,是编译时通过 `env!("CARGO_PKG_VERSION")` 从
`Cargo.toml` 读取的,所以版本号必须写在提交的文件里,tag 只是与之对应的镜像。

```bash
npm run version:tauri:patch              # 把 package.json、tauri.conf.json、Cargo.toml 里的 1.0.x 升到 1.0.(x+1)
git commit -am "chore: release v1.0.90"  # 提交这次版本号变更
git tag v1.0.90 && git push origin v1.0.90
```

然后去 **Actions** 标签查看。首次运行约需 15–25 分钟(两种架构 + 公证排队);之后因为有
Rust 缓存会更快。

> 不要用 `npm run build:mac` 来发版——它会再次 bump 版本号,并产出未签名的本地构建。
> 发版就只是 bump → commit → tag → push。

<a id="一次性配置签名与公证"></a>

## 一次性配置:签名与公证

没有这些 secrets,workflow 仍然会**成功**,只是 `.dmg` 是**未签名**的:下载者会遇到
Gatekeeper 警告,必须右键 → 打开(或运行 `xattr -cr /Applications/SayType.app`)。要
产出可以直接打开的安装包,在 **Settings → Secrets and variables → Actions →
New repository secret** 下添加下列 secrets。

需要付费的 Apple Developer 账号,以及一个 **Developer ID Application** 证书。

| Secret | 怎么获取 |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | `security find-identity -v -p codesigning` 输出里那串完整的 `Developer ID Application: 名字 (TEAMID)` |
| `APPLE_TEAM_ID` | 上面括号里的 10 位 ID(也可在你的 [Membership 页](https://developer.apple.com/account#MembershipDetailsCard) 查到) |
| `APPLE_CERTIFICATE` | 导出的 `.p12` 的 base64(见下文) |
| `APPLE_CERTIFICATE_PASSWORD` | 你导出 `.p12` 时设置的密码 |
| `APPLE_ID` | 你的 Apple Developer 账号邮箱 |
| `APPLE_PASSWORD` | 一个 [App 专用密码](https://appleid.apple.com)(登录与安全 → App 专用密码)——**不是**你的登录密码 |

**导出证书:** 在钥匙串访问 → *登录* 钥匙串 → *我的证书* 中,找到 `Developer ID
Application` 条目(展开确认它带有私钥),右键 → 导出为带密码的 `.p12`,然后把它的
base64 复制到剪贴板:

```bash
base64 -i ~/Desktop/certificate.p12 | pbcopy   # 粘贴到 APPLE_CERTIFICATE
```

如果 `security find-identity` 没有显示任何 `Developer ID Application` 证书,去
[developer.apple.com](https://developer.apple.com/account/resources/certificates/list)
(Certificates → ➕ → Developer ID Application)创建一个,下载 `.cer` 并双击安装后,再
导出。

`tauri.conf.json` 特意保持 `signingIdentity: null`——在 CI 里由 `APPLE_SIGNING_IDENTITY`
环境变量接管,因此不影响本地构建。
