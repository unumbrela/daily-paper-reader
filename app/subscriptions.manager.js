// 订阅管理总模块（智能 Query）
// 负责：
// 1) 维护本地草稿配置
// 2) 统一渲染 intent_profiles
// 3) 保存前仅保留 intent_profiles

window.SubscriptionsManager = (function () {
  let overlay = null;
  let panel = null;
  let saveBtn = null;
  let closeBtn = null;
  let msgEl = null;

  let draftConfig = null;
  let hasUnsavedChanges = false;
  let isSavingDraftConfig = false;

  const defaultPromptTemplate = [
    '你是一名检索规划助手。',
    '用户主题标签: {{TAG}}',
    '用户描述: {{USER_DESCRIPTION}}',
    '检索链路说明: {{RETRIEVAL_CONTEXT}}',
    '',
    '请输出 JSON：',
    '{',
    '  "keywords": [',
    '    {',
      '      "expr": "关键词短语（单条用于召回，多个关键词之间默认 OR）",',
    '      "logic_cn": "仅做中文直译（尽量短，不超过20字）",',
      '      "must_have": ["可选：该关键词关注的核心概念"],',
      '      "optional": ["可选：该关键词相关扩展概念"],',
      '      "exclude": ["可选：尽量避开的概念"],',
      '      "rewrite_for_embedding": "与该关键词语义一致的自然语言短语"',
    '    }',
    '  ],',
    '  "queries": [',
    '    {',
    '      "text": "润色后的语义 Query（供 embedding+ranker+LLM 链路）",',
    '      "logic_cn": "一句中文说明该改写与原始 query 的差异"',
    '    }',
    '  ]',
    '}',
    '要求：',
    '1) keywords 请给出 5~12 条短语，便于用户多选；',
    '2) 避免输出大量“X + 核心术语”冗余形式（如 "deep symbolic regression"）。若核心术语已出现（如 "symbolic regression"），优先输出可独立召回的前缀概念（如 "machine learning"）；',
    '3) queries 最多 3 条，且必须基于原始 query 做同义改写，不要引入新领域/新主题；',
    '4) 如果原始 query 偏学术方向，保持该方向，不做发散；',
    '5) 只输出 JSON，不要输出其它文本。',
  ].join('\n');

  const QUICK_RUN_CONFERENCES = [
    'ACL',
    'AAAI',
    'COLING',
    'EMNLP',
    'ICCV',
    'ICLR',
    'ICML',
    'IJCAI',
    'NeurIPS',
    'SIGIR',
  ];

  const normalizeText = (v) => String(v || '').trim();

  const cloneDeep = (obj) => {
    try {
      return JSON.parse(JSON.stringify(obj || {}));
    } catch {
      return obj || {};
    }
  };

  const uniqList = (arr) => {
    const list = Array.isArray(arr) ? arr : [];
    const seen = new Set();
    const out = [];
    list.forEach((item) => {
      const t = normalizeText(item);
      if (!t) return;
      const key = t.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(t);
    });
    return out;
  };

  const fillQuickRunOptions = (yearSelectEl, confSelectEl) => {
    if (yearSelectEl && !yearSelectEl._dprQuickRunOptionsFilled) {
      yearSelectEl._dprQuickRunOptionsFilled = true;
      const currentYear = new Date().getFullYear();
      for (let y = currentYear; y >= currentYear - 8; y -= 1) {
        const opt = document.createElement('option');
        opt.value = String(y);
        opt.textContent = String(y);
        yearSelectEl.appendChild(opt);
      }
    }

    if (confSelectEl && !confSelectEl._dprQuickRunOptionsFilled) {
      confSelectEl._dprQuickRunOptionsFilled = true;
      QUICK_RUN_CONFERENCES.forEach((name) => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        confSelectEl.appendChild(opt);
      });
    }
  };

  const runQuickFetch = (days, msgEl, tipText) => {
    if (!window.DPRWorkflowRunner || typeof window.DPRWorkflowRunner.runQuickFetchByDays !== 'function') {
      if (msgEl) {
        msgEl.textContent = '工作流触发器未加载到当前页面。';
        msgEl.style.color = '#c00';
      }
      return;
    }
    window.DPRWorkflowRunner.runQuickFetchByDays(days);
    if (msgEl) {
      msgEl.textContent = tipText || `已发起 ${days} 天内抓取任务。`;
      msgEl.style.color = '#080';
    }
  };

  const runQuickConferencePlaceholder = (yearSelectEl, confSelectEl, msgEl) => {
    const year = (yearSelectEl && yearSelectEl.value) || '';
    const conf = String((confSelectEl && confSelectEl.value) || '').trim();
    if (!year || !conf) {
      if (msgEl) {
        msgEl.textContent = '请先选择年份和会议名。';
        msgEl.style.color = '#c00';
      }
      return;
    }
    if (msgEl) {
      msgEl.textContent = `${year} ${conf} 的会议论文抓取功能暂未接入。`;
      msgEl.style.color = '#c90';
    }
  };

  const normalizeKeywordText = (expr) => {
    let s = normalizeText(expr);
    if (!s) return '';
    s = s.replace(/\(/g, ' ').replace(/\)/g, ' ');
    s = s.replace(/\bAND\b|\bOR\b|\bNOT\b|&&|\|\||!/gi, ' ');
    s = s.replace(/\bauthor\s*:\s*/gi, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  };

  const normalizeProfiles = (subs) => {
    const profiles = Array.isArray(subs.intent_profiles) ? subs.intent_profiles : [];
    return profiles
      .map((p, idx) => {
        if (!p || typeof p !== 'object') return null;
        const id = normalizeText(p.id) || `profile-${idx + 1}`;
        const tag = normalizeText(p.tag) || id;
        const description = normalizeText(p.description || '');
        const enabled = p.enabled !== false;

        const keywordRules = (Array.isArray(p.keyword_rules) ? p.keyword_rules : [])
          .map((k, kIdx) => {
            if (!k || typeof k !== 'object') return null;
            const expr = normalizeText(k.expr || k.keyword || '');
            if (!expr) return null;
            const rewrite =
              normalizeText(k.rewrite_for_embedding || '') ||
              normalizeKeywordText(expr);
            return {
              id: normalizeText(k.id) || `${id}-kw-${kIdx + 1}`,
              expr,
              logic_cn: normalizeText(k.logic_cn || ''),
              must_have: uniqList(k.must_have),
              optional: uniqList(k.optional),
              exclude: uniqList(k.exclude),
              rewrite_for_embedding: rewrite,
              enabled: k.enabled !== false,
              source: normalizeText(k.source || 'manual'),
              note: normalizeText(k.note || ''),
            };
          })
          .filter(Boolean);

        const semanticQueries = (Array.isArray(p.semantic_queries) ? p.semantic_queries : [])
          .map((q, qIdx) => {
            if (!q || typeof q !== 'object') return null;
            const text = normalizeText(q.text || q.query || '');
            if (!text) return null;
            return {
              id: normalizeText(q.id) || `${id}-q-${qIdx + 1}`,
              text,
              logic_cn: normalizeText(q.logic_cn || ''),
              enabled: q.enabled !== false,
              source: normalizeText(q.source || 'manual'),
              note: normalizeText(q.note || ''),
            };
          })
          .filter(Boolean);

        return {
          id,
          tag,
          description,
          enabled,
          keyword_rules: keywordRules,
          semantic_queries: semanticQueries,
          updated_at: normalizeText(p.updated_at) || new Date().toISOString(),
        };
      })
      .filter(Boolean);
  };

  const migrateLegacyToProfilesIfNeeded = (subs) => {
    const existingProfiles = normalizeProfiles(subs);
    if (existingProfiles.length > 0) {
      subs.intent_profiles = existingProfiles;
      return subs;
    }

    const profilesByTag = {};
    const ensureProfile = (tag) => {
      const key = normalizeText(tag) || 'default';
      if (!profilesByTag[key]) {
        profilesByTag[key] = {
          id: `profile-${Object.keys(profilesByTag).length + 1}`,
          tag: key,
          description: '',
          enabled: true,
          keyword_rules: [],
          semantic_queries: [],
          updated_at: new Date().toISOString(),
        };
      }
      return profilesByTag[key];
    };

    const keywords = Array.isArray(subs.keywords) ? subs.keywords : [];
    keywords.forEach((item) => {
      if (typeof item === 'string') {
        const kw = normalizeText(item);
        if (!kw) return;
        const p = ensureProfile('default');
        p.keyword_rules.push({
          id: `kw-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
          expr: kw,
          logic_cn: '',
          must_have: [],
          optional: [],
          exclude: [],
          rewrite_for_embedding: normalizeKeywordText(kw),
          enabled: true,
          source: 'legacy',
          note: '',
        });
        return;
      }
      if (!item || typeof item !== 'object') return;
      const kw = normalizeText(item.keyword || '');
      if (!kw) return;
      const tag = normalizeText(item.tag || item.alias || 'default');
      const p = ensureProfile(tag);
      p.keyword_rules.push({
        id: `kw-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        expr: kw,
        logic_cn: normalizeText(item.logic_cn || ''),
        must_have: uniqList(item.must_have),
        optional: uniqList(item.optional || item.related),
        exclude: uniqList(item.exclude),
          rewrite_for_embedding:
            normalizeText(item.rewrite || '') ||
            normalizeKeywordText(kw),
        enabled: item.enabled !== false,
        source: 'legacy',
        note: '',
      });
    });

    const queries = Array.isArray(subs.llm_queries) ? subs.llm_queries : [];
    queries.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const q = normalizeText(item.query || '');
      if (!q) return;
      const tag = normalizeText(item.tag || item.alias || 'default');
      const p = ensureProfile(tag);
      p.semantic_queries.push({
        id: `q-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        text: q,
        logic_cn: normalizeText(item.logic_cn || ''),
        enabled: item.enabled !== false,
        source: 'legacy',
        note: '',
      });
    });

    subs.intent_profiles = Object.values(profilesByTag);
    return subs;
  };

  const normalizeSubscriptions = (config) => {
    const next = cloneDeep(config || {});
    if (!next.subscriptions) next.subscriptions = {};
    const subs = next.subscriptions;

    migrateLegacyToProfilesIfNeeded(subs);
    subs.intent_profiles = normalizeProfiles(subs);

    if (!subs.schema_migration || typeof subs.schema_migration !== 'object') {
      subs.schema_migration = {};
    }
    if (!normalizeText(subs.schema_migration.stage)) {
      subs.schema_migration.stage = 'A';
    }
    if (!normalizeText(subs.schema_migration.diff_threshold_pct)) {
      subs.schema_migration.diff_threshold_pct = 15;
    }

    if (!normalizeText(subs.smart_query_prompt_template)) {
      subs.smart_query_prompt_template = defaultPromptTemplate;
    }
    if (!normalizeText(subs.keyword_recall_mode)) {
      subs.keyword_recall_mode = 'or';
    }

    next.subscriptions = subs;
    return next;
  };

  const setMessage = (text, color) => {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.style.color = color || '#666';
  };

  const ensureOverlay = () => {
    if (overlay && panel) return;
    overlay = document.getElementById('arxiv-search-overlay');
    if (overlay) {
      panel = document.getElementById('arxiv-search-panel');
      return;
    }

    overlay = document.createElement('div');
    overlay.id = 'arxiv-search-overlay';
    overlay.innerHTML = `
      <div id="arxiv-search-panel">
        <div id="arxiv-search-panel-header">
          <div style="font-weight:600;">后台管理</div>
          <div style="display:flex; gap:8px; align-items:center;">
            <button id="arxiv-config-save-btn" class="arxiv-tool-btn" style="padding:2px 10px; background:#2e7d32; color:white;">保存</button>
            <button id="arxiv-open-secret-setup-btn" class="arxiv-tool-btn" style="padding:2px 10px;">密钥配置</button>
            <button id="arxiv-search-close-btn" class="arxiv-tool-btn" style="padding:2px 6px;">关闭</button>
          </div>
        </div>

        <div id="arxiv-search-panel-body">
          <div id="arxiv-search-panel-main">
            <div id="dpr-smart-query-section" class="arxiv-pane dpr-smart-pane">
              <div class="dpr-display-card">
                <div id="dpr-sq-display" class="dpr-sq-display"></div>
              </div>

              <div class="dpr-input-card">
                <div class="dpr-inline-row">
                  <button id="dpr-sq-open-chat-btn" class="arxiv-tool-btn" style="background:#2e7d32; color:#fff;">新增</button>
                </div>
              </div>
            </div>

            <div id="dpr-smart-msg" style="font-size:12px; color:#666; margin-top:10px;">提示：修改后点击「保存」才会写入 config.yaml。</div>
          </div>

          <div id="arxiv-search-quick-run-divider" aria-hidden="true"></div>

          <div id="arxiv-search-quick-run-side">
            <div class="chat-quick-run-title">快速抓取</div>
            <button id="arxiv-admin-quick-run-today-btn" class="chat-quick-run-item" type="button">立即搜寻当天论文</button>
            <button id="arxiv-admin-quick-run-7d-btn" class="chat-quick-run-item" type="button">立即搜寻七天内论文</button>
            <button id="arxiv-admin-quick-run-30d-btn" class="chat-quick-run-item" type="button">立即搜寻三十天内论文</button>
            <div class="chat-quick-run-divider" aria-hidden="true"></div>
            <div class="chat-quick-run-title">会议论文（先保留）</div>
            <div class="chat-quick-run-row">
              <label for="arxiv-admin-quick-run-year-select">年份</label>
              <select id="arxiv-admin-quick-run-year-select">
                <option value="">选择年份</option>
              </select>
            </div>
            <div class="chat-quick-run-row">
              <label for="arxiv-admin-quick-run-conference-select">会议名</label>
              <select id="arxiv-admin-quick-run-conference-select">
                <option value="">选择会议名</option>
              </select>
            </div>
            <button id="arxiv-admin-quick-run-conference-run-btn" class="chat-quick-run-run-btn" type="button">运行</button>
            <div id="arxiv-admin-quick-run-msg" class="chat-quick-run-msg"></div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    panel = document.getElementById('arxiv-search-panel');

    saveBtn = document.getElementById('arxiv-config-save-btn');
    closeBtn = document.getElementById('arxiv-search-close-btn');
    msgEl = document.getElementById('dpr-smart-msg');

    const reloadAll = () => {
      renderFromDraft();
    };

    if (window.SubscriptionsSmartQuery) {
      window.SubscriptionsSmartQuery.attach({
        displayListEl: document.getElementById('dpr-sq-display'),
        openChatBtn: document.getElementById('dpr-sq-open-chat-btn'),
        msgEl,
        reloadAll,
      });
    }

    bindBaseEvents();
  };

  const renderFromDraft = () => {
    const cfg = draftConfig || {};
    const subs = (cfg && cfg.subscriptions) || {};
    const profiles = Array.isArray(subs.intent_profiles) ? subs.intent_profiles : [];
    if (window.SubscriptionsSmartQuery && window.SubscriptionsSmartQuery.render) {
      window.SubscriptionsSmartQuery.render(profiles);
    }
    if (window.SubscriptionsSmartQuery && window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds) {
      window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds();
    }
  };

  const loadSubscriptions = async () => {
    try {
      if (!window.SubscriptionsGithubToken || !window.SubscriptionsGithubToken.loadConfig) {
        throw new Error('SubscriptionsGithubToken.loadConfig 不可用');
      }
      const { config } = await window.SubscriptionsGithubToken.loadConfig();
      draftConfig = normalizeSubscriptions(config || {});
      hasUnsavedChanges = false;
      if (window.SubscriptionsSmartQuery && window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds) {
        window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds();
      }
      renderFromDraft();
      setMessage('已加载配置，可开始编辑。', '#666');
    } catch (e) {
      console.error(e);
      setMessage('加载配置失败，请确认 GitHub Token 可用。', '#c00');
    }
  };

  const saveDraftConfig = async () => {
    if (isSavingDraftConfig) {
      setMessage('正在保存中，请稍后...', '#666');
      return;
    }
    if (!window.SubscriptionsGithubToken || !window.SubscriptionsGithubToken.saveConfig) {
      setMessage('当前无法保存配置，请先完成 GitHub 登录。', '#c00');
      return;
    }
    if (!draftConfig) {
      setMessage('配置尚未加载完成，请先等待配置读取完成后再试。', '#c00');
      return;
    }
    try {
      isSavingDraftConfig = true;
      if (saveBtn) {
        saveBtn.disabled = true;
      }
      setMessage('正在保存配置...', '#666');
      const toSave = normalizeSubscriptions(draftConfig || {});
      await window.SubscriptionsGithubToken.saveConfig(
        toSave,
        'chore: save smart query config from dashboard',
      );
      draftConfig = toSave;
      hasUnsavedChanges = false;
      if (window.SubscriptionsSmartQuery && window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds) {
        window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds();
      }
      setMessage('配置已保存。', '#080');
    } catch (e) {
      console.error(e);
      const msg = e && e.message ? e.message : '未知错误';
      setMessage(`保存配置失败：${msg}`.slice(0, 180), '#c00');
    } finally {
      isSavingDraftConfig = false;
      if (saveBtn) {
        saveBtn.disabled = false;
      }
    }
  };

  const reallyCloseOverlay = () => {
    if (!overlay) return;
    overlay.classList.remove('show');
    setTimeout(() => {
      overlay.style.display = 'none';
    }, 300);
  };

  const closeOverlay = () => {
    if (hasUnsavedChanges) {
      const ok = window.confirm('检测到未保存修改，确认直接关闭并丢弃本地草稿吗？');
      if (!ok) return;
      if (window.SubscriptionsSmartQuery && window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds) {
        window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds();
      }
      draftConfig = null;
      hasUnsavedChanges = false;
    }
    reallyCloseOverlay();
  };

  const openOverlay = () => {
    ensureOverlay();
    if (!overlay) return;
    overlay.style.display = 'flex';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        overlay.classList.add('show');
      });
    });

    if (draftConfig) {
      renderFromDraft();
    } else {
      loadSubscriptions();
    }
  };

  const bindBaseEvents = () => {
    if (closeBtn && !closeBtn._bound) {
      closeBtn._bound = true;
      closeBtn.addEventListener('click', closeOverlay);
    }

    if (overlay && !overlay._boundClick) {
      overlay._boundClick = true;
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) closeOverlay();
      });
    }

    if (saveBtn && !saveBtn._bound) {
      saveBtn._bound = true;
      saveBtn.addEventListener('click', saveDraftConfig);
    }

    const secretBtn = document.getElementById('arxiv-open-secret-setup-btn');
    if (secretBtn && !secretBtn._bound) {
      secretBtn._bound = true;
      secretBtn.addEventListener('click', () => {
        try {
          if (window.DPRSecretSetup && window.DPRSecretSetup.openStep2) {
            window.DPRSecretSetup.openStep2();
          } else {
            alert('当前页面尚未加载密钥配置向导脚本，请刷新后重试。');
          }
        } catch (e) {
          console.error(e);
        }
      });
    }

    const quickRun7dBtn = document.getElementById('arxiv-admin-quick-run-7d-btn');
    const quickRunTodayBtn = document.getElementById('arxiv-admin-quick-run-today-btn');
    const quickRun30dBtn = document.getElementById('arxiv-admin-quick-run-30d-btn');
    const quickRunConferenceBtn = document.getElementById(
      'arxiv-admin-quick-run-conference-run-btn',
    );
    const quickRunYearSelect = document.getElementById('arxiv-admin-quick-run-year-select');
    const quickRunConferenceSelect = document.getElementById(
      'arxiv-admin-quick-run-conference-select',
    );
    const quickRunMsgEl = document.getElementById('arxiv-admin-quick-run-msg');
    fillQuickRunOptions(quickRunYearSelect, quickRunConferenceSelect);

    if (quickRun7dBtn && !quickRun7dBtn._bound) {
      quickRun7dBtn._bound = true;
      quickRun7dBtn.addEventListener('click', () => {
        runQuickFetch(7, quickRunMsgEl);
      });
    }

    if (quickRunTodayBtn && !quickRunTodayBtn._bound) {
      quickRunTodayBtn._bound = true;
      quickRunTodayBtn.addEventListener('click', () => {
        runQuickFetch(1, quickRunMsgEl, '已发起当天论文抓取任务。');
      });
    }

    if (quickRun30dBtn && !quickRun30dBtn._bound) {
      quickRun30dBtn._bound = true;
      quickRun30dBtn.addEventListener('click', () => {
        runQuickFetch(30, quickRunMsgEl);
      });
    }

    if (quickRunConferenceBtn && !quickRunConferenceBtn._bound) {
      quickRunConferenceBtn._bound = true;
      quickRunConferenceBtn.addEventListener('click', () => {
        runQuickConferencePlaceholder(
          quickRunYearSelect,
          quickRunConferenceSelect,
          quickRunMsgEl,
        );
      });
    }

  };

  const init = () => {
    const run = () => {
      ensureOverlay();
      document.addEventListener('ensure-arxiv-ui', () => {
        ensureOverlay();
      });
      if (!document._arxivLoadSubscriptionsEventBound) {
        document._arxivLoadSubscriptionsEventBound = true;
        document.addEventListener('load-arxiv-subscriptions', () => {
          ensureOverlay();
          loadSubscriptions();
          openOverlay();
        });
      }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run);
    } else {
      run();
    }
  };

  return {
    init,
    openOverlay,
    closeOverlay,
    loadSubscriptions,
    markConfigDirty: () => {
      hasUnsavedChanges = true;
    },
    updateDraftConfig: (updater) => {
      const base = draftConfig || {};
      const next = typeof updater === 'function' ? updater(cloneDeep(base)) || base : base;
      draftConfig = normalizeSubscriptions(next);
      hasUnsavedChanges = true;
    },
    getDraftConfig: () => cloneDeep(draftConfig || {}),
  };
})();
