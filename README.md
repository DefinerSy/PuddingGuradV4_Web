# PuddingGuradV4_Web

布丁主题塔防概念 **Web 可玩原型**：站桩核心 + 寿司郎式回转取餐 + 转盘布阵 + 布丁击退（无主角走位）。

## 本地试玩

```bash
cd /workspace   # 或克隆后的仓库根目录
python3 -m http.server 8080
```

浏览器打开 `http://127.0.0.1:8080/`（勿直接用 `file://` 打开，避免部分浏览器限制脚本）。

## GitHub Pages 部署说明

1. 将 `main` 合并进仓库（或确保 `main` 已包含本原型与 `.github/workflows/deploy-pages.yml`）。
2. Actions  workflow **Deploy GitHub Pages** 会在推送 `main` 时把 `index.html`、`css/`、`js/` 同步到 **`gh-pages`** 分支。
3. 在 GitHub 仓库：**Settings → Pages → Build and deployment → Source**：选择 **Deploy from a branch**，Branch 选 **`gh-pages`**，文件夹选 **`/(root)`**，保存。
4. 数分钟后可访问（用户名与仓库名以你的为准）：

   `https://definersy.github.io/PuddingGuradV4_Web/`

若 Pages 未出现，请到 **Actions** 查看部署是否成功；首次使用需在 **Settings → Actions → General** 确认 Workflow 权限允许写入 `contents`。

## 操作

- 在下方回转带 **绿色高亮取餐窗** 内按住盘子，拖到上方 **转盘空位** 部署布丁。
- 布丁会 **击退** 靠近的敌人；焦糖带减速，莓果带持续伤害。
- **按钮或键盘 `1` / `2`**：加宽取餐窗、传送带减速（有冷却）。
- 核心生命归零后点击画面重开。
