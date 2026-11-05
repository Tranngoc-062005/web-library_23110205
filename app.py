"""Hệ thống mượn sách thư viện - backend Flask + SQLite.

Chạy thử:   python app.py
Chạy thật:  gunicorn -w 2 -b 0.0.0.0:8000 app:app
"""
import csv
import io
import os
import re
import secrets
import sqlite3
from datetime import date, datetime, timedelta
from functools import wraps

from flask import Flask, g, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# Vercel functions có filesystem chỉ đọc tại /var/task; chỉ /tmp có thể ghi.
# LƯU Ý: /tmp là vùng tạm, không dùng làm nơi lưu dữ liệu lâu dài khi chạy production.
_DEFAULT_DATA_DIR = (
    os.path.join("/tmp", "vju_library_data")
    if os.environ.get("VERCEL") == "1"
    else os.path.join(BASE_DIR, "data")
)
DATA_DIR = os.environ.get("DATA_DIR", _DEFAULT_DATA_DIR)
DB_PATH = os.path.join(DATA_DIR, "thuvien.db")
LOAN_DAYS = int(os.environ.get("LOAN_DAYS", "14"))          # số ngày mượn mặc định
MAX_ACTIVE_LOANS = int(os.environ.get("MAX_ACTIVE_LOANS", "5"))  # tối đa sách mỗi bạn đọc (chờ duyệt + đang mượn)

os.makedirs(DATA_DIR, exist_ok=True)

app = Flask(__name__, static_folder="static", static_url_path="/static")


def _secret_key():
    key = os.environ.get("SECRET_KEY")
    if key:
        return key
    # Không đặt SECRET_KEY: tự sinh và lưu lại để phiên đăng nhập không mất khi khởi động lại.
    path = os.path.join(DATA_DIR, ".secret_key")
    if os.path.exists(path):
        return open(path).read().strip()
    key = secrets.token_hex(32)
    with open(path, "w") as f:
        f.write(key)
    os.chmod(path, 0o600)
    return key


app.config.update(
    SECRET_KEY=_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # Bật HTTPS ở môi trường thật thì đặt COOKIE_SECURE=1
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "0") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=7),
    MAX_CONTENT_LENGTH=2 * 1024 * 1024,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  email TEXT,
  student_id TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'reader' CHECK (role IN ('admin','reader')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  isbn TEXT NOT NULL DEFAULT '',
  publisher TEXT NOT NULL DEFAULT '',
  year INTEGER,
  copies INTEGER NOT NULL DEFAULT 1 CHECK (copies >= 0),
  location TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending','borrowing','returned','rejected','cancelled')),
  requested_at TEXT NOT NULL,
  approved_at TEXT,
  due_date TEXT,
  returned_at TEXT,
  note TEXT NOT NULL DEFAULT ''
);
