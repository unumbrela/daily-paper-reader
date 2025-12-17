# /home/ubuntu/daily-paper/scripts/daily_job.py
import datetime
import os

# 配置
DOCS_DIR = os.path.expanduser("~/workplace/daily-paper-reader/docs")
TODAY = datetime.date.today().strftime("%Y-%m-%d")
FILE_NAME = f"{TODAY}.md"
FILE_PATH = os.path.join(DOCS_DIR, FILE_NAME)

paper_title = "Attention Is All You Need"
paper_authors = ["Ashish Vaswani", "Noam Shazeer"] # list
pdf_url = "https://arxiv.org/pdf/1706.03762.pdf"
date = TODAY
# --- 生成 Markdown ---


def main():
    # --- 这里是 MVP 的“假”爬虫，之后在这里接入 ArXiv ---
    title = f"Paper generated on {TODAY}"
    content = f"""
**Authors**: {', '.join(paper_authors)}
**Date**: {date}

[Download PDF]({pdf_url})

---

## Abstract
...
"""
    # 1. 写入 Markdown 文件
    with open(FILE_PATH, 'w', encoding='utf-8') as f:
        f.write(content)
    
    # 2. 更新 _sidebar.md (把新文章插到最前面)
    sidebar_path = os.path.join(DOCS_DIR, "_sidebar.md")
    new_entry = f"  * [{TODAY} Paper]({TODAY})\n"
    
    lines = []
    if os.path.exists(sidebar_path):
        with open(sidebar_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
    
    # 找到 "Daily Papers" 这一行，插在它后面
    insert_idx = -1
    for i, line in enumerate(lines):
        if "Daily Papers" in line:
            insert_idx = i + 1
            break
            
    if insert_idx != -1:
        lines.insert(insert_idx, new_entry)
        with open(sidebar_path, 'w', encoding='utf-8') as f:
            f.writelines(lines)
    else:
        # 如果没找到，就追加
        with open(sidebar_path, 'a', encoding='utf-8') as f:
            f.write("\n* Daily Papers\n" + new_entry)

    print(f"Generated {FILE_NAME}")

if __name__ == "__main__":
    main()