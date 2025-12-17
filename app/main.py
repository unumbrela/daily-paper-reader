# /home/ubuntu/daily-paper/app/main.py
import sqlite3
import os
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
import openai

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
CLIENT = openai.OpenAI(api_key="3b5cac0de26145e9a8e5701bf8fbc197.fpqlPzgDbt0UkBJJ", base_url="https://open.bigmodel.cn/api/coding/paas/v4")

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
init_db()

class ChatRequest(BaseModel):
    paper_id: str
    question: str

@app.get("/api/history")
def get_history(paper_id: str):
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.execute("SELECT role, content, created_at FROM comments WHERE paper_id=? ORDER BY id ASC", (paper_id,))
        return [{"role": r[0], "content": r[1], "time": r[2]} for r in cursor.fetchall()]

@app.post("/api/chat")
def chat(req: ChatRequest):
    # 1. 读取本地 Markdown 文件作为上下文（节省上传带宽）
    md_path = os.path.join(DOCS_DIR, f"{req.paper_id}.md")
    if not os.path.exists(md_path):
        raise HTTPException(status_code=404, detail="Paper not found")
    
    with open(md_path, 'r', encoding='utf-8') as f:
        paper_content = f.read()

    # 2. 存用户问题
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("INSERT INTO comments (paper_id, role, content) VALUES (?, ?, ?)", (req.paper_id, "user", req.question))
        # 获取历史用于上下文
        cursor = conn.execute("SELECT role, content FROM comments WHERE paper_id=? ORDER BY id ASC", (req.paper_id,))
        history = cursor.fetchall()

    # 3. 组装 Prompt
    messages = [{"role": "system", "content": "你是学术讨论助手。根据论文内容和历史讨论回答。"}]
    messages.append({"role": "user", "content": f"### 论文全文 ###\n{paper_content}"})
    
    # 将历史对话转为 API 格式
    for role, content in history:
        api_role = "assistant" if role == "ai" else "user"
        # 简单去重：避免把最新的问题重复发两次，或者让 LLM 自己判断
        messages.append({"role": api_role, "content": content})

    # 4. 调用 LLM
    try:
        resp = CLIENT.chat.completions.create(model="glm-4.6", messages=messages, stream=False)
        ai_msg = resp.choices[0].message.content
    except Exception as e:
        ai_msg = f"Error: {str(e)}"

    # 5. 存 AI 回答
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("INSERT INTO comments (paper_id, role, content) VALUES (?, ?, ?)", (req.paper_id, "ai", ai_msg))

    return {"status": "ok"}