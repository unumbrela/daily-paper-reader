# Supabase 优先 + 本地爬取兜底规则

当前最小可落地版本的 Step1 行为（无状态模式）：

1. 直接从 `arxiv_papers` 读取窗口内论文。
2. 若读取成功且返回 >0 条：
   - 写入 `archive/YYYYMMDD/raw/arxiv_papers_YYYYMMDD.json`；
   - 跳过本地 arXiv 抓取。
3. 若 Supabase 查询失败或返回 0 条：
   - 回退到本地 arXiv 抓取流程。

在 `maintainer mode` 下同步到 Supabase 时，会同时写入 `embedding`、`embedding_model`、`embedding_dim`、`embedding_updated_at`（用于后续向量检索）。

配置入口：

- `config.yaml` / `docs/config.yaml`
  - `arxiv_paper_setting.prefer_supabase_read`
  - `supabase.enabled`
  - `supabase.url`
  - `supabase.anon_key`
  - `supabase.papers_table`

## Workflow 自动分流（`maintainer mode` / `user mode`）

`daily-paper-reader.yml` 现已按密钥自动分流：

1. `maintainer mode`（同时配置了 `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`）
   - 执行：本地抓取 arXiv（强制关闭 Supabase 回读）+ 同步 Supabase。
   - 不执行：本地推荐链路（2~6）与仓库提交（不 push docs）。

2. `user mode`（未配置上述 service 密钥）
   - 执行：完整本地链路（0~6）并提交 docs 结果。
   - Step1 内部仍按“Supabase 优先 + 本地兜底”规则读取公共库。
