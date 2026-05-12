# PuddingGuradV4_Web

布丁主题塔防概念 **Web 可玩原型**：站桩核心 + 寿司郎式回转取餐 + 转盘布阵 + 布丁击退（无主角走位）。

## 本地试玩

```bash
cd /workspace   # 或克隆后的仓库根目录
python3 -m http.server 8080
```

浏览器打开 `http://127.0.0.1:8080/`（勿直接用 `file://` 打开，避免部分浏览器限制脚本）。

## GitHub Pages 部署说明

工作流使用 GitHub 官方 **`upload-pages-artifact` + `deploy-pages`**，与 Settings 里的 **Source: GitHub Actions** 一致。

1. 推送 `main` 后会自动运行 **Deploy GitHub Pages**。
2. 在仓库 **Settings → Pages → Build and deployment**：
   - **Source** 请选择 **GitHub Actions**（不要再用「从分支部署」指向 `gh-pages`，除非你刻意改回旧方式）。
3. 首次运行若出现 **Environment `github-pages` 等待审批**，请到 **Actions** 里打开该次运行，点击 **Review deployments → Approve**（仅首次或策略变更时可能出现）。
4. 部署成功后，同一页会显示站点地址，一般为：

   `https://definersy.github.io/PuddingGuradV4_Web/`

若仍无站点，请到 **Actions** 查看 **Deploy GitHub Pages** 是否成功，并确认 **Settings → Actions → General → Workflow permissions** 为 **Read and write permissions**（以便 `GITHUB_TOKEN` 具备 `pages: write` 与 `id-token`）。

## 操作

- 在下方回转带 **绿色高亮取餐窗** 内按住盘子，拖到上方 **转盘空位** 部署布丁。
- 布丁会 **击退** 靠近的敌人；焦糖带减速，莓果带持续伤害。
- **按钮或键盘 `1` / `2`**：加宽取餐窗、传送带减速（有冷却）。
- 核心生命归零后点击画面重开。
