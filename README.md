# Daily Paper Reader（免费 / 开源 / Fork即用）

一个相当智能的 arXiv 论文推荐系统：Fork 后每天自动抓取论文、推荐、生成站点，并支持订阅定制。

## 你能快速得到什么

- 每天自动更新的推荐站（GitHub Pages）
- 可按关键词/意图筛选的推荐流
- 随时提问的gemini-3 论文阅读小助手
- 支持 Fork 后 5 分钟搭建

## 5 分钟快速启动

### 0. 提前准备两个密钥

#### 0.1 获取 `BLT_API_KEY`（柏拉图平台）

> 不是柏拉图行不行？ 对比了市面上的集成平台，柏拉图是性价比最高的，柏拉图平台上有按0.001元/次的reranker模型调用，和非常便宜的gemini3 flash模型: 提示¥0.5/M tokens 补全 ¥3/M tokens，建议还是配这个，每天花费1~3毛钱。

- 打开 [柏拉图（Blt）API 平台](https://api.bltcy.ai/)完成注册/登录
- 充值5元
- 进入 API Key 管理页，新建一个 Key，记录下来后面会用到

#### 0.2 获取 `GITHUB_PAT`（GitHub Personal Access Token）
- 打开 [GitHub 新建 PAT 页面](https://github.com/settings/tokens/new?type=beta&scopes=repo,workflow,gist) 
- 勾选 **这三项权限**（上面链接已预勾选）：
  - `repo`
  - `workflow`
  - `gist`
- 确认

--- 

### 1. Fork 本仓库
仓库页面点 `Fork`。

--- 
以下内容需在自己仓库下执行（因为下面链接均为相对目录），并不是在原仓库中执行

### 2. 开启 Actions
进入你 Fork 的仓库，点 `Actions`，如有提示点击允许 workflow 运行。

### 3. 配置必需密钥（必须）


### 4. 第一次跑通（建议手动触发一次）
- `Actions → daily-paper-reader → Run workflow → Run workflow`
- 成功后可看到：
  - 自动更新 `archive/.../recommend/` 推荐文件
  - 自动更新 `docs/` 页面内容
  - 有 workflow 产物自动 `commit` 到 `main`

### 5. 开启 GitHub Pages
- 点击 [GitHub Pages 设置（相对路径，可直接打开）](../../settings/pages)  
- `Settings → Pages → Source`
- 选 `Deploy from a branch`，分支 `main`，目录 `/docs`，保存
- 站点地址会显示在页面顶部

### 6. 打开站点验收
访问 `https://<你的用户名>.github.io/<仓库名>/`

耗时参考：首次通常 3~8 分钟（取决于网络与论文量），后续更新一般更快。

## 站点模式说明（Fork 用户）

- 用户仓库（无 `SUPABASE_SERVICE_KEY`）：执行完整本地链路，产出推荐站 + 自动提交内容。
- 维护者仓库（配置了 `SUPABASE_SERVICE_KEY`）：执行专用链路，侧重同步到 Supabase，不提交 docs。

> `SUPABASE_SCHEMA` 仅用于数据库 schema 选择，默认 `public` 即可。  
> 不需要做复杂配置，非特别分离场景可直接不设置。

## 订阅配置（最小改法）

- 方式 1（推荐）：修改 `config.yaml` 并提交
- 方式 2：站点后台改（需 GitHub Token）

常见字段：`subscriptions.intent_profiles`、`subscriptions.schema_migration`

## 版本迭代（请持续更新）

| 版本 | 日期 | 更新内容 |
| --- | --- | --- |
| v1.0.0 | 2026-02-19 | 基础功能实现完成 |
| Unreleased | - | 请在每次发布时补充 |

## Star 曲线（项目热度）

[![Star History Chart](https://api.star-history.com/svg?repos=ziwenhahaha/daily-paper-reader&type=Date)](https://star-history.com/#ziwenhahaha/daily-paper-reader&Date)

> 当前仓库：`ziwenhahaha/daily-paper-reader`

## 常见问题（2 分钟排障）

- 站点无内容  
  先看 `Actions` 是否成功；第一次成功运行后才会生成 `docs/`。
- Pages 404  
  检查 `Pages` 是否已指向 `main` + `/docs`。
- workflow 运行失败（重试）  
  先重试一次，若长期失败查看日志中是否为依赖下载/限流。
- 没有更新  
  可能当天无新论文或被过滤，查看 `Actions` 输出的窗口与过滤信息。
- Secret 配了但没生效  
  确认 Secret 名称一致且在 Fork 仓库里配置（不是上游仓库）。

## 参考文件

- 流程说明：`CLAUDE.md`  
- 工作流：`.github/workflows/daily-paper-reader.yml`  
- 配置示例：`config.yaml`  
- Supabase 规则说明：`docs/supabase_fallback_rule.md`
