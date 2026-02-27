#!/usr/bin/env python
# 统一订阅解析模块：
# - 输出 BM25 / Embedding / LLM refine 可直接消费的数据（仅基于 intent_profiles）
# - 支持迁移阶段门禁（A/B/C）

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple
import re

try:
  from query_boolean import clean_expr_for_embedding
except Exception:  # pragma: no cover - 兼容 package 导入路径
  from src.query_boolean import clean_expr_for_embedding


MAIN_TERM_WEIGHT = 1.0
RELATED_TERM_WEIGHT = 0.5
OR_SOFT_WEIGHT = 0.3
DEFAULT_STAGE = "A"
SUPPORTED_STAGES = {"A", "B", "C"}
DEFAULT_KEYWORD_RECALL_MODE = "or"
SUPPORTED_KEYWORD_RECALL_MODES = {"or", "boolean_mixed"}


def _now_iso() -> str:
  return datetime.now(timezone.utc).isoformat()


def _norm_text(v: Any) -> str:
  return str(v or "").strip()


def _slug(s: str) -> str:
  t = _norm_text(s).lower()
  t = re.sub(r"[^a-z0-9]+", "-", t)
  t = re.sub(r"-+", "-", t).strip("-")
  return t or "profile"


def _as_bool(v: Any, default: bool = True) -> bool:
  if isinstance(v, bool):
    return v
  if v is None:
    return default
  s = str(v).strip().lower()
  if s in ("0", "false", "no", "off"):
    return False
  if s in ("1", "true", "yes", "on"):
    return True
  return default


def _uniq_keep_order(items: List[str]) -> List[str]:
  seen = set()
  out: List[str] = []
  for i in items:
    t = _norm_text(i)
    if not t:
      continue
    key = t.lower()
    if key in seen:
      continue
    seen.add(key)
    out.append(t)
  return out


def _to_str_list(v: Any) -> List[str]:
  if not isinstance(v, list):
    return []
  return _uniq_keep_order([_norm_text(x) for x in v])


def get_migration_stage(config: Dict[str, Any]) -> str:
  subs = (config or {}).get("subscriptions") or {}
  migration = subs.get("schema_migration") or {}
  stage = _norm_text((migration or {}).get("stage") or DEFAULT_STAGE).upper()
  if stage not in SUPPORTED_STAGES:
    stage = DEFAULT_STAGE
  return stage


def get_keyword_recall_mode(config_or_subs: Dict[str, Any]) -> str:
  base = config_or_subs or {}
  subs = base.get("subscriptions") if isinstance(base, dict) and isinstance(base.get("subscriptions"), dict) else base
  mode = _norm_text((subs or {}).get("keyword_recall_mode") or DEFAULT_KEYWORD_RECALL_MODE).lower()
  if mode not in SUPPORTED_KEYWORD_RECALL_MODES:
    mode = DEFAULT_KEYWORD_RECALL_MODE
  return mode


def _normalize_keyword_expr(expr: str) -> str:
  return clean_expr_for_embedding(_norm_text(expr)) or _norm_text(expr)


def _normalize_profile(profile: Dict[str, Any], idx: int) -> Dict[str, Any]:
  pid = _norm_text(profile.get("id") or "")
  tag = _norm_text(profile.get("tag") or "")
  description = _norm_text(profile.get("description") or "")
  if not pid:
    pid = f"profile-{idx + 1}-{_slug(tag or description or str(idx + 1))}"
  if not tag:
    tag = pid

  kw_rules_in = profile.get("keywords") or profile.get("keyword_rules") or []
  sq_in = profile.get("semantic_queries") or []
  kw_rules: List[Dict[str, Any]] = []
  sem_queries: List[Dict[str, Any]] = []

  if isinstance(kw_rules_in, list):
    for k_idx, rule in enumerate(kw_rules_in):
      if not isinstance(rule, dict):
        continue
      expr = _norm_text(rule.get("expr") or rule.get("keyword") or "")
      if not expr:
        continue
      rid = _norm_text(rule.get("id") or f"{pid}-kw-{k_idx + 1}")
      rewrite_for_embedding = _normalize_keyword_expr(rule.get("rewrite_for_embedding") or expr)
      kw_rules.append(
        {
          "id": rid,
          "expr": expr,
          "logic_cn": _norm_text(rule.get("logic_cn") or ""),
          "must_have": _to_str_list(rule.get("must_have")),
          "optional": _to_str_list(rule.get("optional")),
          "exclude": _to_str_list(rule.get("exclude")),
          "rewrite_for_embedding": rewrite_for_embedding,
          "enabled": _as_bool(rule.get("enabled"), True),
          "source": _norm_text(rule.get("source") or "manual"),
          "note": _norm_text(rule.get("note") or ""),
        }
      )

  if isinstance(sq_in, list):
    for q_idx, item in enumerate(sq_in):
      if not isinstance(item, dict):
        continue
      text = _norm_text(item.get("text") or item.get("query") or "")
      if not text:
        continue
      qid = _norm_text(item.get("id") or f"{pid}-q-{q_idx + 1}")
      sem_queries.append(
        {
          "id": qid,
          "text": text,
          "logic_cn": _norm_text(item.get("logic_cn") or ""),
          "enabled": _as_bool(item.get("enabled"), True),
          "source": _norm_text(item.get("source") or "manual"),
          "note": _norm_text(item.get("note") or ""),
        }
      )

  return {
    "id": pid,
    "tag": tag,
    "description": description,
    "enabled": _as_bool(profile.get("enabled"), True),
    "keywords": kw_rules,
    "semantic_queries": sem_queries,
    "updated_at": _norm_text(profile.get("updated_at") or _now_iso()),
  }


def _build_from_profiles(subs: Dict[str, Any]) -> Dict[str, Any]:
  raw_profiles = subs.get("intent_profiles") or []
  profiles: List[Dict[str, Any]] = []
  if isinstance(raw_profiles, list):
    for idx, p in enumerate(raw_profiles):
      if not isinstance(p, dict):
        continue
      profiles.append(_normalize_profile(p, idx))

  bm25_queries: List[Dict[str, Any]] = []
  embedding_queries: List[Dict[str, Any]] = []
  context_keywords: List[Dict[str, str]] = []
  context_queries: List[Dict[str, str]] = []
  tags: List[str] = []

  for profile in profiles:
    if not profile.get("enabled", True):
      continue
    tag = _norm_text(profile.get("tag") or "")
    if not tag:
      continue
    tags.append(tag)
    paper_tag_keyword = f"keyword:{tag}"
    paper_tag_query = f"query:{tag}"

    for rule in profile.get("keywords") or profile.get("keyword_rules") or []:
      if not rule.get("enabled", True):
        continue
      expr = _norm_text(rule.get("expr") or "")
      if not expr:
        continue
      bm25_text = _normalize_keyword_expr(expr)
      logic_cn = _norm_text(rule.get("logic_cn") or "")
      rewrite_for_embedding = _normalize_keyword_expr(rule.get("rewrite_for_embedding") or expr)

      query_terms = [{"text": bm25_text, "weight": MAIN_TERM_WEIGHT}]
      for x in _to_str_list(rule.get("optional")):
        query_terms.append({"text": x, "weight": RELATED_TERM_WEIGHT})

      bm25_queries.append(
        {
          "type": "keyword",
          "tag": tag,
          "paper_tag": paper_tag_keyword,
          "query_text": bm25_text,
          "query_terms": query_terms,
          "boolean_expr": "",
          "logic_cn": logic_cn,
          "must_have": _to_str_list(rule.get("must_have")),
          "optional": _to_str_list(rule.get("optional")),
          "exclude": _to_str_list(rule.get("exclude")),
          "source_profile_id": profile.get("id"),
          "source_rule_id": rule.get("id"),
          "source": rule.get("source") or "manual",
          "or_soft_weight": OR_SOFT_WEIGHT,
        }
      )
      embedding_queries.append(
        {
          "type": "keyword",
          "tag": tag,
          "paper_tag": paper_tag_keyword,
          "query_text": rewrite_for_embedding or expr,
          "logic_cn": logic_cn,
          "source_profile_id": profile.get("id"),
          "source_rule_id": rule.get("id"),
          "source": rule.get("source") or "manual",
        }
      )
      context_keywords.append({"tag": paper_tag_keyword, "keyword": expr, "logic_cn": logic_cn})

    for item in profile.get("semantic_queries") or []:
      if not item.get("enabled", True):
        continue
      text = _norm_text(item.get("text") or "")
      if not text:
        continue
      logic_cn = _norm_text(item.get("logic_cn") or "")
      bm25_queries.append(
        {
          "type": "llm_query",
          "tag": tag,
          "paper_tag": paper_tag_query,
          "query_text": text,
          "logic_cn": logic_cn,
          "source_profile_id": profile.get("id"),
          "source_query_id": item.get("id"),
          "source": item.get("source") or "manual",
        }
      )
      embedding_queries.append(
        {
          "type": "llm_query",
          "tag": tag,
          "paper_tag": paper_tag_query,
          "query_text": text,
          "logic_cn": logic_cn,
          "source_profile_id": profile.get("id"),
          "source_query_id": item.get("id"),
          "source": item.get("source") or "manual",
        }
      )
      context_queries.append({"tag": paper_tag_query, "query": text, "logic_cn": logic_cn})

  return {
    "profiles": profiles,
    "bm25_queries": bm25_queries,
    "embedding_queries": embedding_queries,
    "context_keywords": context_keywords,
    "context_queries": context_queries,
    "tags": _uniq_keep_order(tags),
  }


def build_pipeline_inputs(config: Dict[str, Any]) -> Dict[str, Any]:
  """
  统一输出流水线输入：
  - bm25_queries：供 Step 2.1 使用
  - embedding_queries：供 Step 2.2 使用
  - context_keywords/context_queries：供 Step 4 使用
  """
  cfg = config or {}
  subs = (cfg.get("subscriptions") or {}) if isinstance(cfg, dict) else {}
  stage = get_migration_stage(cfg)
  has_profiles = isinstance(subs.get("intent_profiles"), list) and bool(subs.get("intent_profiles"))

  profile_plan = _build_from_profiles(subs) if has_profiles else {}
  plan: Dict[str, Any]
  source = "legacy"
  fallback_used = False

  if has_profiles:
    plan = profile_plan
    source = "intent_profiles"
  else:
    # 阶段 A/B/C：未配置新链路则返回空输入，避免回退到旧结构。
    plan = {
      "profiles": [],
      "bm25_queries": [],
      "embedding_queries": [],
      "context_keywords": [],
      "context_queries": [],
      "tags": [],
    }
    source = "intent_profiles_required_but_missing"

  comparison = {}

  return {
    "stage": stage,
    "source": source,
    "fallback_used": fallback_used,
    "profiles": plan.get("profiles") or [],
    "bm25_queries": plan.get("bm25_queries") or [],
    "embedding_queries": plan.get("embedding_queries") or [],
    "context_keywords": plan.get("context_keywords") or [],
    "context_queries": plan.get("context_queries") or [],
    "tags": _uniq_keep_order(plan.get("tags") or []),
    "comparison": comparison,
  }


def count_subscription_tags(config: Dict[str, Any]) -> Tuple[int, List[str]]:
  plan = build_pipeline_inputs(config or {})
  tags = _uniq_keep_order([_norm_text(x) for x in (plan.get("tags") or [])])
  return len(tags), tags
