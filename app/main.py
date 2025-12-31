# /home/ubuntu/daily-paper/app/main.py
import sqlite3
import os
import json
import time
from datetime import datetime
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import openai
import arxiv

app = FastAPI()

# 允许跨域（方便本地调试，上线后可限制）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 数据库与文件路径配置
DB_FILE = os.path.join(os.path.dirname(__file__), "chat.db")
DOCS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "docs")
LLM_API_KEY = os.getenv("LLM_API_KEY")
if not LLM_API_KEY:
    raise RuntimeError("缺少环境变量 LLM_API_KEY，请设置大模型的 API Key")

# 从环境变量读取模型名称和可选的 Base URL
LLM_MODEL = os.getenv("LLM_MODEL", "glm-4.7")
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://open.bigmodel.cn/api/coding/paas/v4")

# 使用 OpenAI 兼容客户端，建议选择支持 200k 上下文长度的模型
CLIENT = openai.OpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL)

# 系统提示词：统一约束回答语法为「Markdown + LaTeX」
SYSTEM_PROMPT = (
    "你是学术讨论助手，负责围绕论文内容进行深入分析与讨论。"
    "我是用的KaTex来进行渲染，请严格使用「Markdown + LaTeX」表达答案"
)

def init_db():
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                paper_id TEXT, role TEXT, content TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tracked_papers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                arxiv_id TEXT UNIQUE,
                title TEXT,
                authors TEXT,
                pdf_url TEXT,
                published TEXT,
                alias TEXT,
                raw_meta TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS subscriptions_keywords (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                keyword TEXT UNIQUE,
                alias TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS subscriptions_zotero (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                zotero_id TEXT,
                api_key TEXT,
                alias TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        # 兼容旧表：尝试补充缺失的 alias 列
        try:
            conn.execute("ALTER TABLE subscriptions_keywords ADD COLUMN alias TEXT")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE tracked_papers ADD COLUMN alias TEXT")
        except Exception:
            pass
init_db()

class ChatRequest(BaseModel):
    paper_id: str
    question: str  # 前端会传 paper_content，但后端以本地 md/txt 为准读取


class TrackPaperRequest(BaseModel):
    arxiv_id: str
    alias: str | None = None


class KeywordRequest(BaseModel):
    keyword: str
    alias: str | None = None


class ZoteroRequest(BaseModel):
    zotero_id: str
    api_key: str
    alias: str | None = None

@app.get("/api/history")
def get_history(paper_id: str):
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.execute("SELECT role, content, created_at FROM comments WHERE paper_id=? ORDER BY id ASC", (paper_id,))
        return [{"role": r[0], "content": r[1], "time": r[2]} for r in cursor.fetchall()]

@app.post("/api/chat")
def chat(req: ChatRequest):
    # 1. 读取本地 Markdown 文件和预处理后的 txt 文本作为上下文
    md_path = os.path.join(DOCS_DIR, f"{req.paper_id}.md")
    if not os.path.exists(md_path):
        raise HTTPException(status_code=404, detail="Paper not found")
    
    with open(md_path, "r", encoding="utf-8") as f:
        paper_md_content = f.read()

    txt_path = os.path.join(DOCS_DIR, f"{req.paper_id}.txt")
    paper_txt_content = ""
    if os.path.exists(txt_path):
        with open(txt_path, "r", encoding="utf-8") as f:
            paper_txt_content = f.read()

    # 2. 存用户问题
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("INSERT INTO comments (paper_id, role, content) VALUES (?, ?, ?)", (req.paper_id, "user", req.question))
        # 获取历史用于上下文
        cursor = conn.execute("SELECT role, content FROM comments WHERE paper_id=? ORDER BY id ASC", (req.paper_id,))
        history = cursor.fetchall()

    # 3. 组装 Prompt：PDF 文本 + Markdown + 历史讨论 + 本次问题
    messages = [{
        "role": "system",
        "content": SYSTEM_PROMPT,
    }]

    if paper_txt_content:
        messages.append({
            "role": "user",
            "content": f"### 论文 PDF 提取文本 ###\n{paper_txt_content}",
        })

    messages.append({
        "role": "user",
        "content": f"### 论文 Markdown 内容 ###\n{paper_md_content}",
    })
    
    # 将历史对话转为 API 格式（不包含思考过程 thinking）
    for role, content in history:
        if role == "thinking":
            continue
        api_role = "assistant" if role == "ai" else "user"
        messages.append({"role": api_role, "content": content})

    # 4. 调用 LLM
    try:
        resp = CLIENT.chat.completions.create(
            model=LLM_MODEL,
            messages=messages,
            temperature=0.7,  # 模型温度设为 0.7
            stream=False,
        )
        ai_msg = resp.choices[0].message.content
    except Exception as e:
        ai_msg = f"Error: {str(e)}"

    # 5. 存 AI 回答
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("INSERT INTO comments (paper_id, role, content) VALUES (?, ?, ?)", (req.paper_id, "ai", ai_msg))

    return {"status": "ok"}


@app.post("/api/chat_stream")
def chat_stream(req: ChatRequest):
    """
    流式返回 AI 回答，用于前端公共研讨区的流式展示。
    """
    # 1. 读取本地 Markdown 文件和预处理后的 txt 文本作为上下文
    md_path = os.path.join(DOCS_DIR, f"{req.paper_id}.md")
    if not os.path.exists(md_path):
        raise HTTPException(status_code=404, detail="Paper not found")

    with open(md_path, "r", encoding="utf-8") as f:
        paper_md_content = f.read()

    txt_path = os.path.join(DOCS_DIR, f"{req.paper_id}.txt")
    paper_txt_content = ""
    if os.path.exists(txt_path):
        with open(txt_path, "r", encoding="utf-8") as f:
            paper_txt_content = f.read()

    # 2. 存用户问题，并取出历史用于上下文
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute(
            "INSERT INTO comments (paper_id, role, content) VALUES (?, ?, ?)",
            (req.paper_id, "user", req.question),
        )
        cursor = conn.execute(
            "SELECT role, content FROM comments WHERE paper_id=? ORDER BY id ASC",
            (req.paper_id,),
        )
        history = cursor.fetchall()

    # 3. 组装 Prompt
    messages = [{
        "role": "system",
        "content": SYSTEM_PROMPT,
    }]

    if paper_txt_content:
        messages.append({
            "role": "user",
            "content": f"### 论文 PDF 提取文本 ###\n{paper_txt_content}",
        })

    messages.append({
        "role": "user",
        "content": f"### 论文 Markdown 内容 ###\n{paper_md_content}",
    })

    for role, content in history:
        if role == "thinking":
            continue
        api_role = "assistant" if role == "ai" else "user"
        messages.append({"role": api_role, "content": content})

    def generate():
        full_answer = ""
        full_thinking = ""
        try:
            stream = CLIENT.chat.completions.create(
                model=LLM_MODEL,
                messages=messages,
                temperature=0.7,
                stream=True,
            )
            for chunk in stream:
                delta = chunk.choices[0].delta

                # 一些模型会在 delta 中提供 “思考 / 推理” 内容（例如 reasoning_content 或 thinking 字段）
                thinking = getattr(delta, "reasoning_content", None) or getattr(delta, "thinking", None)
                if thinking:
                    # 以按行 JSON 的方式输出，前端根据 type 字段区分
                    full_thinking += thinking
                    payload = {"type": "thinking", "content": thinking}
                    yield json.dumps(payload, ensure_ascii=False) + "\n"

                content_piece = getattr(delta, "content", None) or ""
                if not content_piece:
                    continue
                full_answer += content_piece
                # 流式输出答案内容
                payload = {"type": "answer", "content": content_piece}
                yield json.dumps(payload, ensure_ascii=False) + "\n"
        except Exception as e:
            err_msg = f"{str(e)}"
            payload = {"type": "error", "content": err_msg}
            yield json.dumps(payload, ensure_ascii=False) + "\n"
            return

        # 流结束后，把思考过程与完整回答写入数据库
        with sqlite3.connect(DB_FILE) as conn:
            if full_thinking.strip():
                conn.execute(
                    "INSERT INTO comments (paper_id, role, content) VALUES (?, ?, ?)",
                    (req.paper_id, "thinking", full_thinking),
                )
            if full_answer.strip():
                conn.execute(
                    "INSERT INTO comments (paper_id, role, content) VALUES (?, ?, ?)",
                    (req.paper_id, "ai", full_answer),
                )

    return StreamingResponse(generate(), media_type="text/plain")


_last_arxiv_search_ts = 0.0


@app.get("/api/arxiv_search")
def arxiv_search(query: str = Query(..., min_length=1, description="论文标题、关键词或 arxiv 链接")):
    """
    使用 arxiv 包搜索论文：
    - 3 秒内只能搜索一次（简单的全局限流，防止误触）
    - 支持直接输入 arxiv 链接或论文标题/关键词
    """
    global _last_arxiv_search_ts

    now_ts = time.time()
    if now_ts - _last_arxiv_search_ts < 3.0:
        raise HTTPException(status_code=429, detail="搜索过于频繁，请稍后再试")

    raw = query.strip()
    if not raw:
        raise HTTPException(status_code=400, detail="query 不能为空")

    client = arxiv.Client()

    # 1. 如果是 arxiv 链接或 ID，优先按 ID 精确查询
    arxiv_id = None
    if "arxiv.org" in raw:
        # 提取 arxiv ID，支持多种格式
        # https://arxiv.org/abs/2512.07961
        # https://arxiv.org/pdf/2512.07961.pdf
        # http://arxiv.org/abs/2512.07961v1
        import re
        # 匹配 /abs/ 或 /pdf/ 后面的 ID
        match = re.search(r'/(?:abs|pdf)/(\d{4}\.\d{4,5}(?:v\d+)?)', raw)
        if match:
            arxiv_id = match.group(1)
        else:
            # 如果没匹配到，尝试更宽松的匹配
            match = re.search(r'(\d{4}\.\d{4,5}(?:v\d+)?)', raw)
            if match:
                arxiv_id = match.group(1)
    elif ":" not in raw and " " not in raw and len(raw) >= 9 and "." in raw:
        # 粗略认为是 arxiv id，如 2512.12345 或 2512.12345v2
        arxiv_id = raw

    results = []

    try:
        if arxiv_id:
            search = arxiv.Search(id_list=[arxiv_id])
        else:
            # 按标题 + 全字段混合搜索
            query_str = f'ti:"{raw}" OR all:"{raw}"'
            search = arxiv.Search(
                query=query_str,
                max_results=10,
                sort_by=arxiv.SortCriterion.SubmittedDate,
                sort_order=arxiv.SortOrder.Descending,
            )

        for idx, result in enumerate(client.results(search)):
            if idx >= 10:
                break
            title = (result.title or "").strip()
            authors = [a.name for a in result.authors] if result.authors else []
            pdf_url = result.pdf_url
            short_id = result.get_short_id()
            published = ""
            if isinstance(result.published, datetime):
                published = result.published.date().isoformat()

            results.append(
                {
                    "arxiv_id": short_id,
                    "title": title,
                    "authors": authors,
                    "pdf_url": pdf_url,
                    "summary": (result.summary or "").strip(),
                    "published": published,
                    "primary_category": getattr(result, "primary_category", ""),
                }
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"arxiv 搜索失败: {e}")
    finally:
        _last_arxiv_search_ts = now_ts

    return {"items": results}


@app.post("/api/arxiv_track")
def arxiv_track(req: TrackPaperRequest):
    """
    将选中的 arxiv 论文持久化到本地 tracked_papers。
    如果 arxiv_id 已存在则忽略。
    """
    client = arxiv.Client()
    try:
        search = arxiv.Search(id_list=[req.arxiv_id])
        result = next(client.results(search), None)
        if result is None:
            raise HTTPException(status_code=404, detail="未找到指定 arxiv 论文")

        title = (result.title or "").strip()
        authors = [a.name for a in result.authors] if result.authors else []
        pdf_url = result.pdf_url
        published = ""
        if isinstance(result.published, datetime):
            published = result.published.date().isoformat()

        raw_meta = {
            "title": title,
            "authors": authors,
            "pdf_url": pdf_url,
            "summary": (result.summary or "").strip(),
            "published": published,
            "primary_category": getattr(result, "primary_category", ""),
        }
        alias = (req.alias or "").strip()

        with sqlite3.connect(DB_FILE) as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO tracked_papers (arxiv_id, title, authors, pdf_url, published, alias, raw_meta)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    req.arxiv_id,
                    title,
                    json.dumps(authors, ensure_ascii=False),
                    pdf_url,
                    published,
                    alias,
                    json.dumps(raw_meta, ensure_ascii=False),
                ),
            )
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存选中论文失败: {e}")


@app.get("/api/subscriptions")
def get_subscriptions():
    """
    返回当前订阅信息：
    - 关键词列表
    - 需要跟踪引用的论文列表
    - Zotero 账号列表
    """
    with sqlite3.connect(DB_FILE) as conn:
        # 关键词
        cursor = conn.execute(
            "SELECT id, keyword, alias, created_at FROM subscriptions_keywords ORDER BY id ASC"
        )
        keywords = [
            {"id": row[0], "keyword": row[1], "alias": row[2], "created_at": row[3]}
            for row in cursor.fetchall()
        ]

        # 订阅论文
        cursor = conn.execute(
            "SELECT id, arxiv_id, title, authors, published, alias, created_at FROM tracked_papers ORDER BY created_at DESC"
        )
        papers = []
        for row in cursor.fetchall():
            try:
                authors = json.loads(row[3]) if row[3] else []
            except Exception:
                authors = []
            papers.append(
                {
                    "id": row[0],
                    "arxiv_id": row[1],
                    "title": row[2],
                    "authors": authors,
                    "published": row[4],
                    "alias": row[5],
                    "created_at": row[6],
                }
            )
        # Zotero 账号（出于安全考虑，这里不返回 api_key）
        cursor = conn.execute(
            "SELECT id, zotero_id, alias, created_at FROM subscriptions_zotero ORDER BY id ASC"
        )
        zotero_accounts = [
            {
                "id": row[0],
                "zotero_id": row[1],
                "alias": row[2],
                "created_at": row[3],
            }
            for row in cursor.fetchall()
        ]

    return {"keywords": keywords, "tracked_papers": papers, "zotero_accounts": zotero_accounts}


@app.post("/api/subscriptions/keyword")
def add_keyword(req: KeywordRequest):
    kw = (req.keyword or "").strip()
    alias = (req.alias or "").strip()
    if not kw:
        raise HTTPException(status_code=400, detail="关键词不能为空")
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute(
            "INSERT OR IGNORE INTO subscriptions_keywords (keyword, alias) VALUES (?, ?)",
            (kw, alias),
        )
    return {"status": "ok"}


@app.delete("/api/subscriptions/keyword/{kid}")
def delete_keyword(kid: int):
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("DELETE FROM subscriptions_keywords WHERE id=?", (kid,))
    return {"status": "ok"}


@app.delete("/api/arxiv_track/{tid}")
def delete_tracked_paper(tid: int):
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("DELETE FROM tracked_papers WHERE id=?", (tid,))
    return {"status": "ok"}


@app.post("/api/subscriptions/zotero/verify")
def verify_zotero(req: ZoteroRequest):
    """
    验证 Zotero 账号是否有效，通过调用 Zotero API 检查
    """
    import requests
    
    zid = (req.zotero_id or "").strip()
    key = (req.api_key or "").strip()
    
    if not zid or not key:
        raise HTTPException(status_code=400, detail="Zotero ID 和 API Key 不能为空")
    
    try:
        # 调用 Zotero API 获取用户信息
        url = f"https://api.zotero.org/users/{zid}/items"
        headers = {
            "Zotero-API-Key": key,
            "Zotero-API-Version": "3"
        }
        params = {"limit": 1}  # 只获取一条记录来验证
        
        response = requests.get(url, headers=headers, params=params, timeout=10)
        
        if response.status_code == 200:
            return {"status": "ok", "valid": True, "message": "验证成功"}
        elif response.status_code == 403:
            return {"status": "error", "valid": False, "message": "API Key 无效或权限不足"}
        elif response.status_code == 404:
            return {"status": "error", "valid": False, "message": "用户 ID 不存在"}
        else:
            return {"status": "error", "valid": False, "message": f"验证失败: HTTP {response.status_code}"}
    
    except requests.exceptions.Timeout:
        raise HTTPException(status_code=408, detail="请求超时，请检查网络连接")
    except requests.exceptions.RequestException as e:
        raise HTTPException(status_code=500, detail=f"网络请求失败: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"验证失败: {str(e)}")


@app.post("/api/subscriptions/zotero")
def add_zotero(req: ZoteroRequest):
    zid = (req.zotero_id or "").strip()
    key = (req.api_key or "").strip()
    alias = (req.alias or "").strip()
    if not zid or not key:
        raise HTTPException(status_code=400, detail="Zotero ID 和 Key 不能为空")
    if not alias:
        raise HTTPException(status_code=400, detail="备注不能为空")
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute(
            """
            INSERT INTO subscriptions_zotero (zotero_id, api_key, alias)
            VALUES (?, ?, ?)
            """,
            (zid, key, alias),
        )
    return {"status": "ok"}


@app.delete("/api/subscriptions/zotero/{zid}")
def delete_zotero(zid: int):
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("DELETE FROM subscriptions_zotero WHERE id=?", (zid,))
    return {"status": "ok"}
