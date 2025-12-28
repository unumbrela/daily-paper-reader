// 私人研讨区模块：负责聊天 UI、LLM 配置与本地记忆（IndexedDB）
window.PrivateDiscussionChat = (function () {
  const LLM_CONFIG_KEY = 'dpr_llm_config_v1';
  const CHAT_HISTORY_KEY = 'dpr_chat_history_v1'; // 仅用于旧版本迁移
  const CHAT_DB_NAME = 'dpr_chat_db_v1';
  const CHAT_STORE_NAME = 'paper_chats';

  const loadLLMConfig = () => {
    try {
      if (!window.localStorage) return {};
      const raw = window.localStorage.getItem(LLM_CONFIG_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return {};

      // 新结构：包含 deepseek / plato 键时直接返回
      if (obj.deepseek || obj.plato) {
        return obj;
      }

      // 兼容旧结构：{ provider, apiKey, models, selectedModel }
      if (obj.provider) {
        const migrated = {
          deepseek: {},
          plato: {},
          selectedModel: obj.selectedModel || undefined,
        };
        if (obj.provider === 'deepseek' || obj.provider === 'plato') {
          migrated[obj.provider] = {
            apiKey: obj.apiKey || '',
            okModels: Array.isArray(obj.models) ? obj.models : [],
          };
        }
        return migrated;
      }

      return obj;
    } catch {
      return {};
    }
  };

  const saveLLMConfig = (cfg) => {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(cfg));
    } catch {
      // ignore
    }
  };

  const MODEL_PROVIDER_MAP = {
    'deepseek-reasoner': 'deepseek',
    'gpt-5.2-thinking': 'plato',
    'gemini-3-pro-preview': 'plato',
    'gemini-2.5-pro': 'plato',
  };

  const getProviderMeta = (provider) => {
    if (provider === 'plato') {
      return {
        id: 'plato',
        label: '柏拉图',
        endpoint: 'https://api.bltcy.ai/v1/chat/completions',
      };
    }
    return {
      id: 'deepseek',
      label: 'DeepSeek',
      endpoint: 'https://api.deepseek.com/chat/completions',
    };
  };

  const getCandidateModelsForProvider = (provider) => {
    return Object.keys(MODEL_PROVIDER_MAP).filter(
      (m) => MODEL_PROVIDER_MAP[m] === provider,
    );
  };

  const getAllCandidateModels = () => Object.keys(MODEL_PROVIDER_MAP);

  const getProviderForModel = (model) => MODEL_PROVIDER_MAP[model] || null;

  const getDefaultModelForProvider = (provider) => {
    if (provider === 'plato') {
      return 'gemini-2.5-pro';
    }
    return 'deepseek-reasoner';
  };

  const testModels = async (apiKey, provider) => {
    const okModels = getCandidateModelsForProvider(provider);

    if (provider === 'deepseek') {
      try {
        const resp = await fetch('https://api.deepseek.com/user/balance', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        });
        if (!resp.ok) {
          return { okModels: [], info: `HTTP ${resp.status}` };
        }
        const data = await resp.json().catch(() => null);
        if (!data || !data.is_available || !Array.isArray(data.balance_infos)) {
          return { okModels: [], info: '余额信息获取失败' };
        }
        const first = data.balance_infos[0] || {};
        const total = first.total_balance || '0';
        return { okModels, info: `余额：¥${total}` };
      } catch (e) {
        return { okModels: [], info: '请求失败' };
      }
    }

    if (provider === 'plato') {
      try {
        const resp = await fetch('https://api.bltcy.ai/v1/token/quota', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        });
        if (!resp.ok) {
          return { okModels: [], info: `HTTP ${resp.status}` };
        }
        const data = await resp.json().catch(() => null);
        const quota =
          data && typeof data.quota === 'number' ? data.quota : 0;
        const used = -quota;
        const usedStr = used.toFixed(2);
        return { okModels, info: `已用：${usedStr}` };
      } catch (e) {
        return { okModels: [], info: '请求失败' };
      }
    }

    return { okModels: [], info: '未知服务商' };
  };

  let chatDbPromise = null;

  const openChatDB = () => {
    if (chatDbPromise) return chatDbPromise;
    if (typeof indexedDB === 'undefined') {
      chatDbPromise = Promise.resolve(null);
      return chatDbPromise;
    }
    chatDbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(CHAT_DB_NAME, 1);
        req.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(CHAT_STORE_NAME)) {
            db.createObjectStore(CHAT_STORE_NAME, { keyPath: 'paperId' });
          }
        };
        req.onsuccess = (event) => {
          const db = event.target.result;
          // 迁移旧版 localStorage 聊天记录
          try {
            if (window.localStorage) {
              const raw = window.localStorage.getItem(CHAT_HISTORY_KEY);
              if (raw) {
                const obj = JSON.parse(raw) || {};
                const tx = db.transaction(CHAT_STORE_NAME, 'readwrite');
                const store = tx.objectStore(CHAT_STORE_NAME);
                Object.keys(obj).forEach((pid) => {
                  const list = obj[pid];
                  if (pid && Array.isArray(list)) {
                    store.put({ paperId: pid, messages: list });
                  }
                });
                tx.oncomplete = () => {
                  window.localStorage.removeItem(CHAT_HISTORY_KEY);
                };
              }
            }
          } catch {
            // ignore
          }
          resolve(db);
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return chatDbPromise;
  };

  const loadChatHistory = async (paperId) => {
    if (!paperId) return [];
    const db = await openChatDB();
    if (!db) {
      try {
        if (!window.localStorage) return [];
        const raw = window.localStorage.getItem(CHAT_HISTORY_KEY);
        if (!raw) return [];
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return [];
        const list = obj[paperId];
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(CHAT_STORE_NAME, 'readonly');
        const store = tx.objectStore(CHAT_STORE_NAME);
        const req = store.get(paperId);
        req.onsuccess = () => {
          const record = req.result;
          if (record && Array.isArray(record.messages)) {
            resolve(record.messages);
          } else {
            resolve([]);
          }
        };
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  };

  const saveChatHistory = async (paperId, list) => {
    if (!paperId) return;
    const db = await openChatDB();
    if (!db) {
      try {
        if (!window.localStorage) return;
        const raw = window.localStorage.getItem(CHAT_HISTORY_KEY);
        const obj = raw ? JSON.parse(raw) || {} : {};
        obj[paperId] = list;
        window.localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(obj));
      } catch {
        // ignore
      }
      return;
    }
    try {
      const tx = db.transaction(CHAT_STORE_NAME, 'readwrite');
      const store = tx.objectStore(CHAT_STORE_NAME);
      store.put({ paperId, messages: list });
    } catch {
      // ignore
    }
  };

  const renderChatUI = () => {
    return `
      <div id="paper-chat-container">
        <div class="chat-header">💬 私人研讨区 (Private Discussion)</div>
        <div id="chat-history">
            <div style="text-align:center; color:#999">暂无讨论，输入你的想法开始对话（仅保存在本机）</div>
        </div>
        <div class="input-area">
          <textarea id="user-input" rows="3" placeholder="针对这篇论文提问，仅自己可见..."></textarea>
          <button id="send-btn">发送</button>
        </div>
        <div class="chat-footer">
          <button id="chat-settings-btn" class="chat-settings-btn">⚙️ 模型设置</button>
          <select id="chat-llm-model-select" class="chat-model-select"></select>
          <span id="chat-status" class="chat-status"></span>
        </div>
        <div id="chat-settings-panel" class="chat-settings-panel" style="display:none;">
          <div class="chat-settings-row">
            <label for="chat-llm-deepseek-api-key">DeepSeek：</label>
            <input id="chat-llm-deepseek-api-key" type="password" autocomplete="off" placeholder="DeepSeek API Key" />
            <span id="chat-llm-deepseek-status" class="chat-settings-inline-status"></span>
          </div>
          <div class="chat-settings-row">
            <label for="chat-llm-plato-api-key">柏拉图：</label>
            <input id="chat-llm-plato-api-key" type="password" autocomplete="off" placeholder="柏拉图 API Key" />
            <span id="chat-llm-plato-status" class="chat-settings-inline-status"></span>
          </div>
          <div class="chat-settings-actions">
            <button id="chat-settings-save-btn">测试并保存</button>
            <button id="chat-settings-cancel-btn" type="button">关闭</button>
          </div>
          <div class="chat-settings-hint">
            模型配置与对话内容仅保存在本机浏览器，不会上传到服务器。
          </div>
        </div>
      </div>
    `;
  };

  const renderHistory = async (paperId) => {
    const historyDiv = document.getElementById('chat-history');
    if (!historyDiv) return;

    const data = await loadChatHistory(paperId);
    if (!data || !data.length) {
      historyDiv.innerHTML =
        '<div style="text-align:center; color:#999">暂无讨论，输入上方问题开始提问。</div>';
      return;
    }

    const { renderMarkdownWithTables, renderMathInEl } = window.DPRMarkdown || {};
    historyDiv.innerHTML = '';
    data.forEach((msg) => {
      const item = document.createElement('div');
      item.className = 'msg-item';

      const header = document.createElement('div');
      const roleSpan = document.createElement('span');
      const isThinking = msg.role === 'thinking';
      const isAi = msg.role === 'ai' || isThinking;
      roleSpan.className = 'msg-role ' + (isAi ? 'ai' : 'user');
      roleSpan.textContent = isThinking
        ? '🧠 AI 思考过程'
        : msg.role === 'ai'
          ? '🤖 私人助手'
          : '👤 你';
      const timeSpan = document.createElement('span');
      timeSpan.className = 'msg-time';
      timeSpan.textContent = msg.time || '';
      header.appendChild(roleSpan);
      header.appendChild(timeSpan);

      if (!isThinking) {
        const contentDiv = document.createElement('div');
        contentDiv.className = 'msg-content';
        const markdown = msg.content || '';
        if (renderMarkdownWithTables) {
          contentDiv.innerHTML = renderMarkdownWithTables(markdown);
        } else {
          contentDiv.textContent = markdown;
        }
        if (renderMathInEl) {
          renderMathInEl(contentDiv);
        }

        item.appendChild(header);
        item.appendChild(contentDiv);
        historyDiv.appendChild(item);
        return;
      }

      const thinkingContainer = document.createElement('div');
      thinkingContainer.className = 'thinking-history-container';

      const thinkingHeader = document.createElement('div');
      thinkingHeader.className = 'thinking-history-header';
      const titleSpan = document.createElement('span');
      titleSpan.textContent = '思考过程';
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'thinking-history-toggle';
      toggleBtn.textContent = '展开';
      thinkingHeader.appendChild(titleSpan);
      thinkingHeader.appendChild(toggleBtn);

      const thinkingContent = document.createElement('div');
      thinkingContent.className =
        'msg-content thinking-history-content thinking-collapsed';
      const markdown = msg.content || '';
      if (renderMarkdownWithTables) {
        thinkingContent.innerHTML = renderMarkdownWithTables(markdown);
      } else {
        thinkingContent.textContent = markdown;
      }
      if (renderMathInEl) {
        renderMathInEl(thinkingContent);
      }

      thinkingContainer.appendChild(thinkingHeader);
      thinkingContainer.appendChild(thinkingContent);

      toggleBtn.addEventListener('click', () => {
        const collapsed = thinkingContent.classList.toggle('thinking-collapsed');
        toggleBtn.textContent = collapsed ? '展开' : '折叠';
      });

      item.appendChild(header);
      item.appendChild(thinkingContainer);
      historyDiv.appendChild(item);
    });

    historyDiv.scrollTop = historyDiv.scrollHeight;

    // 聊天历史渲染完成后，通知 Zotero 元数据刷新一次（包含最新对话）
    try {
      if (window.DPRZoteroMeta && window.DPRZoteroMeta.updateFromPage) {
        // vm.route.file 在前端不可见，这里只传 paperId，后端函数会使用当前路由
        window.DPRZoteroMeta.updateFromPage(paperId);
      }
    } catch {
      // 忽略刷新失败
    }
  };

  const sendMessage = async (paperId) => {
    const input = document.getElementById('user-input');
    const btn = document.getElementById('send-btn');
    const statusEl = document.getElementById('chat-status');
    const question = input.value.trim();
    let paperContent = '';

    // 优先使用与后端一致的 .txt 抽取全文作为上下文（不截断）
    if (paperId) {
      try {
        const txtUrl = `docs/${paperId}.txt`;
        const resp = await fetch(txtUrl);
        if (resp.ok) {
          const txt = await resp.text();
          if (txt && txt.trim()) {
            paperContent = txt;
            const snippet = txt.slice(0, 50).replace(/\s+/g, ' ');
            console.log(
              `[DPR DEBUG] paper_txt_content (${paperId}): '${snippet}'`,
            );
          } else {
            console.log(
              `[DPR DEBUG] paper_txt_content (${paperId}): <empty or whitespace>`,
            );
          }
        } else {
          console.log(
            `[DPR DEBUG] paper_txt_content (${paperId}): <http ${resp.status}>`,
          );
        }
      } catch {
        console.log(
          `[DPR DEBUG] paper_txt_content (${paperId}): <fetch failed>`,
        );
      }
    }

    // 回退策略：如果 .txt 不存在，就用页面正文纯文本
    if (!paperContent) {
      paperContent =
        (document.querySelector('.markdown-section') || {}).innerText ||
        '';
    }

    if (!question) return;

    input.disabled = true;
    btn.disabled = true;
    btn.innerText = '思考中...';

    const historyDiv = document.getElementById('chat-history');
    const nowStr = new Date().toLocaleString();
    historyDiv.innerHTML += `
        <div class="msg-item">
            <div><span class="msg-role user">👤 你</span><span class="msg-time">${nowStr}</span></div>
            <div class="msg-content">${question}</div>
        </div>
    `;
    historyDiv.scrollTop = historyDiv.scrollHeight;

    const aiItem = document.createElement('div');
    aiItem.className = 'msg-item';
    aiItem.innerHTML = `
        <div>
          <span class="msg-role ai">🤖 私人助手</span>
          <span class="msg-time">${nowStr}</span>
        </div>
        <div class="thinking-container" style="margin-top:8px; border-left:3px solid #ddd; padding-left:8px; font-size:0.85rem; color:#666; display:none;">
          <div style="display:flex; align-items:center; justify-content:space-between;">
            <span>思考过程</span>
            <button class="thinking-toggle" style="margin-left:8px; font-size:0.75rem; padding:2px 6px;">展开</button>
          </div>
          <div class="thinking-content" style="white-space:pre-wrap; margin-top:4px;"></div>
        </div>
        <div class="msg-content"></div>
    `;
    historyDiv.appendChild(aiItem);

    const thinkingContainer = aiItem.querySelector('.thinking-container');
    const thinkingContent = aiItem.querySelector('.thinking-content');
    const toggleBtn = aiItem.querySelector('.thinking-toggle');
    const aiAnswerDiv = aiItem.querySelector('.msg-content');

    const history = await loadChatHistory(paperId);

    // 调试：打印历史消息前 50 个字符
    try {
      history.forEach((m, idx) => {
        const role = m.role || 'unknown';
        const snippet = (m.content || '').slice(0, 50).replace(/\s+/g, ' ');
        console.log(
          `[DPR DEBUG] history[${idx}] role=${role}: '${snippet}'`,
        );
      });
      const qSnippet = question.slice(0, 50).replace(/\s+/g, ' ');
      console.log(`[DPR DEBUG] current_question: '${qSnippet}'`);
    } catch {
      // 忽略调试输出错误
    }
    history.push({
      role: 'user',
      content: question,
      time: nowStr,
    });
    await saveChatHistory(paperId, history);

    // 用户发起提问后，立即刷新一次 Zotero 摘要（包含最新提问）
    try {
      if (window.DPRZoteroMeta && window.DPRZoteroMeta.updateFromPage) {
        window.DPRZoteroMeta.updateFromPage(paperId);
      }
    } catch {
      // 忽略刷新失败
    }

    const cfg = loadLLMConfig();
    const deepCfg = cfg.deepseek || {};
    const platoCfg = cfg.plato || {};
    const deepOk = Array.isArray(deepCfg.okModels) ? deepCfg.okModels : [];
    const platoOk = Array.isArray(platoCfg.okModels) ? platoCfg.okModels : [];
    const models = Array.from(new Set([...deepOk, ...platoOk]));
    const modelSelect = document.getElementById('chat-llm-model-select');

    if (!models.length) {
      aiAnswerDiv.textContent =
        '尚未测试可用模型，请在「⚙️ 模型设置」中点击“测试并保存”。';
      if (statusEl) {
        statusEl.textContent =
          '尚未测试可用模型，请先使用「测试并保存」。';
        statusEl.style.color = '#c00';
      }
      input.disabled = false;
      btn.disabled = false;
      btn.innerText = '发送';
      return;
    }

    // 选择默认模型：优先用户上次选的，其次各平台推荐默认，再其次任何已通过测试的模型
    const preferredDeep = getDefaultModelForProvider('deepseek');
    const preferredPlato = getDefaultModelForProvider('plato');
    const selectedModel =
      (modelSelect && models.includes(modelSelect.value) && modelSelect.value) ||
      (cfg.selectedModel && models.includes(cfg.selectedModel) && cfg.selectedModel) ||
      (models.includes(preferredDeep) && preferredDeep) ||
      (models.includes(preferredPlato) && preferredPlato) ||
      models[0];
    const model = selectedModel;

    const providerId = getProviderForModel(model);
    const meta = getProviderMeta(providerId);
    const providerCfg =
      providerId === 'plato' ? platoCfg : deepCfg;
    const apiKey = (providerCfg.apiKey || '').trim();

    if (!apiKey) {
      aiAnswerDiv.textContent =
        '尚未配置大模型 API Key，请点击下方「⚙️ 模型设置」后重试。';
      if (statusEl) {
        statusEl.textContent =
          '未配置模型，请先在「⚙️ 模型设置」中填入 API Key。';
        statusEl.style.color = '#c00';
      }
      input.disabled = false;
      btn.disabled = false;
      btn.innerText = '发送';
      return;
    }

    if (!model) {
      aiAnswerDiv.textContent =
        '尚未配置模型名称，请在「⚙️ 模型设置」中填写 model。';
      if (statusEl) {
        statusEl.textContent = '未配置模型名称，请在设置中填写。';
        statusEl.style.color = '#c00';
      }
      input.disabled = false;
      btn.disabled = false;
      btn.innerText = '发送';
      return;
    }

    if (statusEl) {
      statusEl.textContent = `正在调用 ${meta.label} · 模型 ${model}...`;
      statusEl.style.color = '#666';
    }

    let thinkingBuffer = '';
    let answerBuffer = '';
    // 默认以折叠模式展示思考过程，仅显示前若干行
    let thinkingCollapsed = true;
    let renderTimer = null;

    const { renderMarkdownWithTables, renderMathInEl } =
      window.DPRMarkdown || {};

    const applyThinkingView = () => {
      if (!thinkingBuffer || !thinkingContent) return;
      const source = thinkingBuffer;
      const maxLines = 6;
      let toRender = source;

      if (thinkingCollapsed) {
        const lines = source.split('\n');
        if (lines.length > maxLines) {
          toRender =
            lines.slice(0, maxLines).join('\n') +
            '\n...（已折叠，点击展开查看更多思考过程）';
        }
      }

      if (renderMarkdownWithTables) {
        thinkingContent.innerHTML = renderMarkdownWithTables(toRender);
      } else {
        thinkingContent.textContent = toRender;
      }
      if (renderMathInEl) {
        renderMathInEl(thinkingContent);
      }
    };

    const applyAnswerView = () => {
      if (!aiAnswerDiv) return;
      const content = answerBuffer || '（空响应）';
      if (renderMarkdownWithTables) {
        aiAnswerDiv.innerHTML = renderMarkdownWithTables(content);
      } else {
        aiAnswerDiv.textContent = content;
      }
      if (renderMathInEl) {
        renderMathInEl(aiAnswerDiv);
      }
    };

    if (toggleBtn && thinkingContainer) {
      toggleBtn.addEventListener('click', () => {
        thinkingCollapsed = !thinkingCollapsed;
        toggleBtn.textContent = thinkingCollapsed ? '展开' : '折叠';
        applyThinkingView();
      });
    }

    const scheduleRender = () => {
      if (renderTimer) return;
      renderTimer = requestAnimationFrame(() => {
        renderTimer = null;
        if (thinkingBuffer && thinkingContainer) {
          thinkingContainer.style.display = 'block';
          applyThinkingView();
        }
        if (answerBuffer) {
          applyAnswerView();
        }
      });
    };

    try {
      const messages = [];
      messages.push({
        role: 'system',
        content:
          '你是学术讨论助手，负责围绕当前论文内容进行深入分析与讨论。请使用中文回答，并使用 Markdown + LaTeX 表达公式。',
      });
      // 使用全文上下文（优先 .txt 抽取结果），不再做 8000 字截断
      if (paperContent) {
        messages.push({
          role: 'user',
          content: `下面是当前论文的完整纯文本内容（可能包含自动抽取噪声，仅供参考）：\n\n${paperContent}`,
        });
      }

          const prev = await loadChatHistory(paperId);
      prev.forEach((m) => {
        if (m.role === 'user' || m.role === 'ai') {
          messages.push({
            role: m.role === 'ai' ? 'assistant' : 'user',
            content: m.content || '',
          });
        }
      });

      messages.push({
        role: 'user',
          content: question,
      });

      const resp = await fetch(meta.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
        }),
      });

      if (!resp.ok) {
        aiAnswerDiv.textContent = `请求失败: HTTP ${resp.status}`;
        if (statusEl) {
          statusEl.textContent = `调用 ${meta.label} 失败: HTTP ${resp.status}`;
          statusEl.style.color = '#c00';
        }
        return;
      }

      if (!resp.body) {
        // 回退：如果不支持流，则按一次性响应处理
        const data = await resp.json();
        const answer =
          data &&
          data.choices &&
          data.choices[0] &&
          data.choices[0].message &&
          data.choices[0].message.content
            ? data.choices[0].message.content
            : '（模型未返回内容）';
        answerBuffer = answer;
        scheduleRender();
      } else {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';

          for (const part of parts) {
            const line = part.trim();
            if (!line || !line.startsWith('data:')) continue;
            const jsonStr = line.replace(/^data:\s*/, '');
            if (jsonStr === '[DONE]') continue;
            let payload;
            try {
              payload = JSON.parse(jsonStr);
            } catch {
              continue;
            }
            const choice =
              payload.choices && payload.choices[0]
                ? payload.choices[0]
                : null;
            const delta = choice ? choice.delta || {} : {};
            const reasoning =
              delta.reasoning_content || delta.thinking || '';
            const contentPiece = delta.content || '';

            if (reasoning) {
              thinkingBuffer += reasoning;
            }
            if (contentPiece) {
              answerBuffer += contentPiece;
            }
            if (reasoning || contentPiece) {
              scheduleRender();
            }
          }
        }
      }

      const nowStrAnswer = new Date().toLocaleString();
      const updated = await loadChatHistory(paperId);
      if (thinkingBuffer.trim()) {
        updated.push({
          role: 'thinking',
          content: thinkingBuffer,
          time: nowStrAnswer,
        });
      }
      updated.push({
        role: 'ai',
        content: answerBuffer || '（模型未返回内容）',
      time: nowStrAnswer,
    });
    await saveChatHistory(paperId, updated);

      // 新一轮对话完成后，再次刷新 Zotero 元数据
      try {
        if (window.DPRZoteroMeta && window.DPRZoteroMeta.updateFromPage) {
          window.DPRZoteroMeta.updateFromPage(paperId);
        }
      } catch {
        // 忽略刷新失败
      }

      if (statusEl) {
        statusEl.textContent = `已使用模型 ${model}`;
        statusEl.style.color = '#4caf50';
      }

      input.value = '';
    } catch (e) {
      console.error(e);
      aiAnswerDiv.textContent = '发送失败，请检查网络或模型配置。';
      if (statusEl) {
        statusEl.textContent = '发送失败，请检查网络或模型配置。';
        statusEl.style.color = '#c00';
      }
    } finally {
      input.disabled = false;
      btn.disabled = false;
      btn.innerText = '发送';
      input.focus();
    }
  };

  const initForPage = (paperId) => {
    const mainContent = document.querySelector('.markdown-section');
    if (!mainContent || !paperId) return;

    const container = document.createElement('div');
    container.innerHTML = renderChatUI();
    mainContent.appendChild(container);

    const sendBtnEl = document.getElementById('send-btn');
    const inputEl = document.getElementById('user-input');
    const settingsBtn = document.getElementById('chat-settings-btn');
    const settingsPanel = document.getElementById('chat-settings-panel');
    const deepKeyInput = document.getElementById('chat-llm-deepseek-api-key');
    const platoKeyInput = document.getElementById('chat-llm-plato-api-key');
    const deepStatusEl = document.getElementById('chat-llm-deepseek-status');
    const platoStatusEl = document.getElementById('chat-llm-plato-status');
    const saveBtn = document.getElementById('chat-settings-save-btn');
    const cancelBtn = document.getElementById('chat-settings-cancel-btn');
    const statusEl = document.getElementById('chat-status');
    const modelSelect = document.getElementById('chat-llm-model-select');

    if (sendBtnEl) {
      sendBtnEl.addEventListener('click', () => {
        sendMessage(paperId);
      });
    }
    if (inputEl) {
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          sendMessage(paperId);
        }
      });
    }

    if (
      settingsBtn &&
      settingsPanel &&
      deepKeyInput &&
      platoKeyInput &&
      saveBtn
    ) {
      const cfg = loadLLMConfig();
      const deepCfg = cfg.deepseek || {};
      const platoCfg = cfg.plato || {};

      deepKeyInput.value = deepCfg.apiKey || '';
      platoKeyInput.value = platoCfg.apiKey || '';

      // 初始化状态与下拉模型列表
      if (modelSelect) {
        const hasAnyApiKey = !!deepCfg.apiKey || !!platoCfg.apiKey;
        const deepOk = Array.isArray(deepCfg.okModels)
          ? deepCfg.okModels
          : [];
        const platoOk = Array.isArray(platoCfg.okModels)
          ? platoCfg.okModels
          : [];
        const allModels = getAllCandidateModels();
        modelSelect.innerHTML = '';

        // 构建所有候选模型项（始终展示四个模型）
        allModels.forEach((m) => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;

          const provider = getProviderForModel(m);
          const providerCfg =
            provider === 'plato' ? platoCfg : deepCfg;
          const providerHasKey = !!(providerCfg && providerCfg.apiKey);
          const providerOk =
            provider === 'plato' ? platoOk : deepOk;

          if (!providerHasKey) {
            opt.disabled = true;
            opt.title = '需先为对应服务商配置 API Key';
          } else if (providerOk.length && !providerOk.includes(m)) {
            opt.disabled = true;
            opt.title =
              '该模型尚未通过测试，请使用上方「测试并保存」按钮重新测试';
          } else if (!providerOk.length) {
            opt.disabled = true;
            opt.title =
              '已配置 API Key，请使用上方「测试并保存」获取可用模型列表';
          }

          modelSelect.appendChild(opt);
        });

        // 选择默认值（即便是灰色项，主要用于展示当前偏好）
        const preferredDeep = getDefaultModelForProvider('deepseek');
        const preferredPlato = getDefaultModelForProvider('plato');
        const initial =
          (cfg.selectedModel && allModels.includes(cfg.selectedModel)) ||
          (allModels.includes(preferredDeep) && preferredDeep) ||
          (allModels.includes(preferredPlato) && preferredPlato) ||
          allModels[0];
        if (initial) {
          modelSelect.value = initial;
        }
        modelSelect.style.display = 'inline-block';
        modelSelect.disabled = false;

        if (statusEl) {
          const enabledModels = new Set([...deepOk, ...platoOk]);
          if (!hasAnyApiKey) {
            statusEl.textContent =
              '未配置模型，请点击右侧「⚙️ 模型设置」。';
            statusEl.style.color = '#c00';
          } else if (!enabledModels.size) {
            statusEl.textContent =
              '已配置 API Key，请点击「测试并保存」获取可用模型列表。';
            statusEl.style.color = '#666';
          } else {
            const selectedModel = modelSelect.value;
            statusEl.textContent = `已配置模型 ${selectedModel}`;
            statusEl.style.color = '#4caf50';
          }
        }
      } else if (statusEl) {
        statusEl.textContent = '请先配置 API Key';
        statusEl.style.color = '#666';
      }

      settingsBtn.addEventListener('click', () => {
        const visible =
          settingsPanel.style.display &&
          settingsPanel.style.display !== 'none';
        settingsPanel.style.display = visible ? 'none' : 'block';
      });

      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          settingsPanel.style.display = 'none';
        });
      }

      saveBtn.addEventListener('click', async () => {
        const deepKey = (deepKeyInput.value || '').trim();
        const platoKey = (platoKeyInput.value || '').trim();
        const newCfg = loadLLMConfig();
        newCfg.deepseek = newCfg.deepseek || {};
        newCfg.plato = newCfg.plato || {};

        newCfg.deepseek.apiKey = deepKey;
        newCfg.plato.apiKey = platoKey;

        if (statusEl) {
          statusEl.textContent = '正在测试各模型可用性...';
          statusEl.style.color = '#666';
        }
        if (deepStatusEl) {
          deepStatusEl.textContent = deepKey ? '测试中...' : '未配置';
          deepStatusEl.style.color = deepKey ? '#666' : '#999';
        }
        if (platoStatusEl) {
          platoStatusEl.textContent = platoKey ? '测试中...' : '未配置';
          platoStatusEl.style.color = platoKey ? '#666' : '#999';
        }

        const tasks = [];
        if (deepKey) {
          tasks.push(
            testModels(deepKey, 'deepseek').then((result) => {
              newCfg.deepseek.okModels = result.okModels || [];
              if (deepStatusEl) {
                if (result.okModels && result.okModels.length) {
                  deepStatusEl.textContent =
                    result.info || '测试成功，余额信息已获取';
                  deepStatusEl.style.color = '#4caf50';
                } else {
                  deepStatusEl.textContent =
                    result.info || '测试失败';
                  deepStatusEl.style.color = '#c00';
                }
              }
            }),
          );
        } else {
          newCfg.deepseek.okModels = [];
        }

        if (platoKey) {
          tasks.push(
            testModels(platoKey, 'plato').then((result) => {
              newCfg.plato.okModels = result.okModels || [];
              if (platoStatusEl) {
                if (result.okModels && result.okModels.length) {
                  platoStatusEl.textContent =
                    result.info || '测试成功，额度信息已获取';
                  platoStatusEl.style.color = '#4caf50';
                } else {
                  platoStatusEl.textContent =
                    result.info || '测试失败';
                  platoStatusEl.style.color = '#c00';
                }
              }
            }),
          );
        } else {
          newCfg.plato.okModels = [];
        }

        await Promise.all(tasks);

        // 选择全局默认模型：优先 DeepSeek 默认，其次柏拉图默认，再次任意可用模型
        const deepOk = Array.isArray(newCfg.deepseek.okModels)
          ? newCfg.deepseek.okModels
          : [];
        const platoOk = Array.isArray(newCfg.plato.okModels)
          ? newCfg.plato.okModels
          : [];
        const allEnabled = Array.from(new Set([...deepOk, ...platoOk]));

        let selectedModel = newCfg.selectedModel;
        if (!selectedModel || !allEnabled.includes(selectedModel)) {
          const preferredDeep = getDefaultModelForProvider('deepseek');
          const preferredPlato = getDefaultModelForProvider('plato');
          if (allEnabled.includes(preferredDeep)) {
            selectedModel = preferredDeep;
          } else if (allEnabled.includes(preferredPlato)) {
            selectedModel = preferredPlato;
          } else {
            selectedModel = allEnabled[0] || '';
          }
        }
        newCfg.selectedModel = selectedModel;
        saveLLMConfig(newCfg);

        // 更新下拉框与总状态
        if (modelSelect) {
          const allModels = getAllCandidateModels();
          modelSelect.innerHTML = '';
          allModels.forEach((m) => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            const provider = getProviderForModel(m);
            const okList =
              provider === 'plato'
                ? newCfg.plato.okModels || []
                : newCfg.deepseek.okModels || [];
            const hasKey =
              provider === 'plato'
                ? !!newCfg.plato.apiKey
                : !!newCfg.deepseek.apiKey;
            if (!hasKey) {
              opt.disabled = true;
              opt.title = '需先为对应服务商配置 API Key';
            } else if (okList.length && !okList.includes(m)) {
              opt.disabled = true;
              opt.title =
                '该模型尚未通过测试，请重新测试或选择已通过测试的模型';
            } else if (!okList.length) {
              opt.disabled = true;
              opt.title =
                '已配置 API Key，请使用上方「测试并保存」获取可用模型列表';
            }
            modelSelect.appendChild(opt);
          });
          if (selectedModel) {
            modelSelect.value = selectedModel;
          }
          modelSelect.disabled = false;
          modelSelect.style.display = 'inline-block';

          modelSelect.onchange = () => {
            const cfgNow = loadLLMConfig();
            cfgNow.selectedModel = modelSelect.value;
            saveLLMConfig(cfgNow);
            if (statusEl) {
              statusEl.textContent = `已配置模型 ${modelSelect.value}`;
              statusEl.style.color = '#4caf50';
            }
          };
        }

        if (statusEl) {
          if (allEnabled.length) {
            statusEl.textContent = `测试成功，可用模型：${allEnabled.join(
              ', ',
            )}`;
            statusEl.style.color = '#4caf50';
          } else {
            statusEl.textContent =
              '尚未找到可用模型，请检查 API Key 或稍后重试。';
            statusEl.style.color = '#c00';
          }
        }

        // 测试完成后保留设置面板开启，方便查看余额和额度
      });
    }

    renderHistory(paperId).catch(() => {});
  };

  return {
    initForPage,
  };
})();
