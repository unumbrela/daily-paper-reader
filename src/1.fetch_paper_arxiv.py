#!/usr/bin/env python
# 兼容入口：历史脚本名 -> 现有实现（1.1.fetch_paper_arxiv.py）

from __future__ import annotations

import os
import runpy


SCRIPT_DIR = os.path.dirname(__file__)
TARGET = os.path.join(SCRIPT_DIR, "1.1.fetch_paper_arxiv.py")


if __name__ == "__main__":
    runpy.run_path(TARGET, run_name="__main__")
