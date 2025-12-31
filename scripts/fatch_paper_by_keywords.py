#!/usr/bin/env python
"""
每日论文抓取脚本
从订阅的关键词抓取最新论文，生成摘要并保存到 docs 目录
"""

import os
import sys
import re
import time
import json
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
import requests
import arxiv
import fitz  # PyMuPDF
import openai

# 配置
DOCS_DIR = os.path.expanduser("~/workplace/daily-paper-reader/docs")
PAPERS_DIR = os.path.join(DOCS_DIR, "papers")
DB_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "app", "chat.db")

# 确保目录存在
os.makedirs(PAPERS_DIR, exist_ok=True)
os.makedirs(DOCS_DIR, exist_ok=True)

# 大模型配置
LLM_API_KEY = os.getenv("LLM_API_KEY", "6db3f0f8d95a4e3491a47bf349467f11.uh6Hh5ucQySi7rXk")
LLM_MODEL = os.getenv("LLM_MODEL", "glm-4.7")
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://open.bigmodel.cn/api/coding/paas/v4")
CLIENT = openai.OpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL)


def get_keywords():
    """获取所有订阅的关键词"""
    keywords = []

    # 优先从数据库读取
    try:
        if os.path.exists(DB_FILE):
            with sqlite3.connect(DB_FILE) as conn:
                cursor = conn.execute("SELECT keyword FROM subscriptions_keywords ORDER BY id ASC")
                keywords = [row[0] for row in cursor.fetchall()]
    except Exception as e:
        print(f"Error reading keywords from database: {e}")

    # 如果数据库为空，从环境变量读取
    if not keywords:
        env_keywords = os.getenv("ARXIV_KEYWORDS", "")
        if env_keywords:
            keywords = [k.strip() for k in env_keywords.split(",")]

    return keywords


def sanitize_filename(arxiv_id):
    """清理 ArXiv ID 作为文件名"""
    # 移除版本号，如 v1, v2 等
    arxiv_id = re.sub(r'v\d+$', '', arxiv_id)
    # 替换斜杠为横杠
    arxiv_id = arxiv_id.replace('/', '-')
    return arxiv_id


def paper_exists(arxiv_id):
    """检查论文是否已经处理过"""
    filename = sanitize_filename(arxiv_id)
    md_path = os.path.join(DOCS_DIR, f"{filename}.md")
    return os.path.exists(md_path)


def download_pdf(arxiv_id):
    """下载论文 PDF"""
    try:
        # 构造 PDF URL
        pdf_url = f"https://arxiv.org/pdf/{arxiv_id}.pdf"

        # 下载 PDF
        response = requests.get(pdf_url, timeout=30)
        response.raise_for_status()

        # 保存 PDF
        pdf_path = os.path.join(PAPERS_DIR, f"{sanitize_filename(arxiv_id)}.pdf")
        with open(pdf_path, 'wb') as f:
            f.write(response.content)

        return pdf_path
    except Exception as e:
        print(f"Error downloading PDF for {arxiv_id}: {e}")
        return None


def extract_text_from_pdf(pdf_path):
    """从 PDF 提取文本"""
    try:
        doc = fitz.open(pdf_path)
        text = ""

        # 提取所有页面的文本
        for page in doc:
            text += page.get_text()

        doc.close()
        return text
    except Exception as e:
        print(f"Error extracting text from PDF: {e}")
        return None


def generate_qa_summary(paper_text, paper_info):
    """使用 LLM 生成 Q&A 形式的摘要"""
    try:
        prompt = f"""
请基于以下论文信息，以Q&A形式生成一个简洁明了的解读（中文）：

论文标题：{paper_info['title']}
作者：{', '.join(paper_info['authors'][:5])}
摘要：{paper_info['summary']}

要求：
1. 生成3-5个关键问题和答案
2. 问题应该围绕论文的核心贡献、方法和发现
3. 答案要简洁明了，每点不超过100字
4. 使用Markdown格式

## 论文解读

### Q1: 这篇论文主要解决了什么问题？
A1: ...

### Q2: 使用了什么关键方法？
A2: ...

### Q3: 主要发现或贡献是什么？
A3: ...

### Q4: 这项研究有什么应用前景？
A4: ...

论文全文（前5000字）：
{paper_text[:5000]}
"""

        response = CLIENT.chat.completions.create(
            model=LLM_MODEL,
            messages=[
                {"role": "system", "content": "你是一个专业的学术解读助手，擅长将复杂的论文内容简化为易懂的问答形式。"},
                {"role": "user", "content": prompt}
            ],
            stream=False,
            temperature=0.3
        )

        return response.choices[0].message.content
    except Exception as e:
        print(f"Error generating summary: {e}")
        return None


def save_paper_to_docs(paper_info, qa_summary, pdf_text):
    """保存论文到 docs 目录"""
    try:
        filename = sanitize_filename(paper_info['arxiv_id'])

        # 保存提取的文本
        txt_path = os.path.join(PAPERS_DIR, f"{filename}.txt")
        with open(txt_path, 'w', encoding='utf-8') as f:
            f.write(pdf_text)

        # 生成 Markdown 文件
        md_content = f"""# {paper_info['title']}

**ArXiv ID**: {paper_info['arxiv_id']}
**作者**: {', '.join(paper_info['authors'][:10])}{'...' if len(paper_info['authors']) > 10 else ''}
**发布日期**: {paper_info['published']}
**PDF**: [下载链接](https://arxiv.org/pdf/{paper_info['arxiv_id']}.pdf)

## 摘要

{paper_info['summary']}

---

{qa_summary}

---

*此论文由每日抓取系统自动处理*
"""

        md_path = os.path.join(DOCS_DIR, f"{filename}.md")
        with open(md_path, 'w', encoding='utf-8') as f:
            f.write(md_content)

        print(f"Saved paper to: {md_path}")
        return True
    except Exception as e:
        print(f"Error saving paper: {e}")
        return False


def fetch_by_keywords(keywords):
    """根据关键词抓取论文"""
    total_papers = 0
    processed_papers = 0
    new_papers = []

    for keyword in keywords:
        print(f"\n=== 搜索关键词: {keyword} ===")

        try:
            # 搜索最近一周的论文（测试用）
            search = arxiv.Search(
                query=f'all:"{keyword}"',
                max_results=10,
                sort_by=arxiv.SortCriterion.SubmittedDate,
                sort_order=arxiv.SortOrder.Descending
            )

            keyword_papers = 0
            for result in search.results():
                # 检查是否是最近一周的论文（测试用）
                week_ago = datetime.now() - timedelta(days=7)
                if result.published.replace(tzinfo=None) < week_ago:
                    continue

                total_papers += 1
                keyword_papers += 1

                arxiv_id = result.get_short_id()
                print(f"  找到论文: {arxiv_id} - {result.title[:50]}...")

                # 检查是否已处理
                if paper_exists(arxiv_id):
                    print(f"  ✓ 已存在，跳过")
                    continue

                print(f"  → 处理新论文...")
                processed_papers += 1

                # 构建论文信息
                paper_info = {
                    'arxiv_id': arxiv_id,
                    'title': result.title,
                    'authors': [author.name for author in result.authors],
                    'published': result.published.strftime("%Y-%m-%d"),
                    'summary': (result.summary or "").strip()
                }

                # 下载 PDF
                print(f"  下载 PDF...")
                pdf_path = download_pdf(arxiv_id)
                if not pdf_path:
                    print(f"  ✗ 下载失败，跳过")
                    continue

                # 提取文本
                print(f"  提取文本...")
                pdf_text = extract_text_from_pdf(pdf_path)
                if not pdf_text:
                    print(f"  ✗ 文本提取失败，跳过")
                    continue

                # 生成摘要
                print(f"  生成摘要...")
                qa_summary = generate_qa_summary(pdf_text, paper_info)
                if not qa_summary:
                    print(f"  ✗ 摘要生成失败，跳过")
                    continue

                # 保存到 docs
                if save_paper_to_docs(paper_info, qa_summary, pdf_text):
                    new_papers.append(paper_info['title'])
                    print(f"  ✓ 处理完成")
                else:
                    print(f"  ✗ 保存失败")

                # 每处理一个论文稍作等待
                time.sleep(1)

            print(f"  关键词 '{keyword}' 找到 {keyword_papers} 篇论文")

            # 避免触发风控，每个关键词搜索后等待
            time.sleep(3)

        except Exception as e:
            print(f"搜索关键词 '{keyword}' 时出错: {e}")
            continue

    return {
        "total_papers": total_papers,
        "processed_papers": processed_papers,
        "new_papers": new_papers
    }


def main():
    """主函数"""
    print("=== 每日论文抓取开始 ===")
    print(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    # 获取关键词
    keywords = get_keywords()
    if not keywords:
        print("没有找到任何关键词订阅")
        return

    print(f"\n找到 {len(keywords)} 个关键词: {', '.join(keywords[:5])}{'...' if len(keywords) > 5 else ''}")

    # 抓取论文
    result = fetch_by_keywords(keywords)

    # 输出统计
    print(f"\n=== 抓取完成 ===")
    print(f"总论文数: {result['total_papers']}")
    print(f"处理论文数: {result['processed_papers']}")
    print(f"新增论文数: {len(result['new_papers'])}")

    if result['new_papers']:
        print("\n新增论文:")
        for title in result['new_papers']:
            print(f"  - {title[:80]}...")


if __name__ == "__main__":
    main()
