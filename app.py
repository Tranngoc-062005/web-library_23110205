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
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
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
CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);
CREATE INDEX IF NOT EXISTS idx_loans_user ON loans(user_id);
CREATE INDEX IF NOT EXISTS idx_loans_book ON loans(book_id);
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
"""

SAMPLE_BOOKS = [
    ("Giáo trình Lập trình Python", "Nguyễn Văn An", "Công nghệ thông tin", "9786041000011", "NXB Đại học Quốc gia Hà Nội", 2022, 4, "Kệ A1", "Nhập môn lập trình với Python cho sinh viên năm nhất."),
    ("Cấu trúc dữ liệu và giải thuật", "Trần Minh Đức", "Công nghệ thông tin", "9786041000028", "NXB Giáo dục", 2021, 3, "Kệ A1", "Các cấu trúc dữ liệu cơ bản và thuật toán kinh điển."),
    ("Tiếng Nhật cho mọi người - Sơ cấp 1", "3A Corporation", "Ngôn ngữ", "9786041000035", "NXB Trẻ", 2020, 6, "Kệ B2", "Giáo trình tiếng Nhật trình độ N5."),
    ("Kinh tế vi mô", "Nguyễn Thị Hoa", "Kinh tế", "9786041000042", "NXB Kinh tế Quốc dân", 2019, 2, "Kệ C3", "Các nguyên lý cơ bản của kinh tế học vi mô."),
    ("Lịch sử Việt Nam", "Phan Huy Lê", "Lịch sử", "9786041000059", "NXB Chính trị Quốc gia", 2018, 2, "Kệ D1", "Tổng quan lịch sử Việt Nam qua các thời kỳ."),
    ("Văn hóa Nhật Bản", "Lê Thu Hà", "Văn hóa", "9786041000066", "NXB Thế giới", 2017, 3, "Kệ D2", "Giới thiệu văn hóa, phong tục và đời sống Nhật Bản."),
    ("Xác suất thống kê", "Đặng Hùng Thắng", "Toán học", "9786041000073", "NXB Giáo dục", 2020, 5, "Kệ E1", "Lý thuyết xác suất và thống kê ứng dụng."),
    ("Giải tích 1", "Nguyễn Đình Trí", "Toán học", "9786041000080", "NXB Giáo dục", 2016, 4, "Kệ E1", "Giáo trình giải tích hàm một biến."),
    ("Kỹ năng giao tiếp trong công việc", "Phạm Quang Huy", "Kỹ năng", "9786041000097", "NXB Lao động", 2021, 2, "Kệ F1", "Kỹ năng giao tiếp, thuyết trình, làm việc nhóm."),
    ("Cơ sở dữ liệu", "Lê Hoàng Nam", "Công nghệ thông tin", "9786041000103", "NXB Đại học Quốc gia Hà Nội", 2022, 3, "Kệ A2", "Thiết kế, truy vấn và quản trị cơ sở dữ liệu quan hệ."),
]


# --------------------------------------------------------------------- DB
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def today_str():
    return date.today().isoformat()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(SCHEMA)
    db.execute("PRAGMA journal_mode = WAL")
    # Tài khoản thủ thư mặc định (đổi bằng biến môi trường ADMIN_USER / ADMIN_PASSWORD)
    if db.execute("SELECT COUNT(*) FROM users WHERE role='admin'").fetchone()[0] == 0:
        admin_user = os.environ.get("ADMIN_USER", "admin")
        admin_pass = os.environ.get("ADMIN_PASSWORD")
        generated = False
        if not admin_pass:
            admin_pass = secrets.token_urlsafe(9)
            generated = True
        db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, created_at) VALUES (?,?,?,?,?)",
            (admin_user, "Quản trị viên", generate_password_hash(admin_pass), "admin", now_str()),
        )
        db.commit()
        if generated:
            print("=" * 60)
            print(f"Đã tạo tài khoản thủ thư: {admin_user} / {admin_pass}")
            print("Hãy đăng nhập và ghi lại mật khẩu này (chỉ hiện một lần).")
            print("Muốn tự đặt mật khẩu: đặt biến môi trường ADMIN_PASSWORD trước lần chạy đầu.")
            print("=" * 60)
    # Nạp sách mẫu khi đặt SEED_SAMPLE=1 và kho sách đang trống
    if os.environ.get("SEED_SAMPLE") == "1" and db.execute("SELECT COUNT(*) FROM books").fetchone()[0] == 0:
        db.executemany(
            "INSERT INTO books (title, author, category, isbn, publisher, year, copies, location, description, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            [b + (now_str(),) for b in SAMPLE_BOOKS],
        )
        db.commit()
    db.close()


# ------------------------------------------------------------- helpers
def err(message, code=400):
    return jsonify({"error": message}), code


def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    u = get_db().execute("SELECT * FROM users WHERE id=? AND active=1", (uid,)).fetchone()
    if u is None:
        session.clear()
    return u


def login_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        u = current_user()
        if u is None:
            return err("Bạn cần đăng nhập.", 401)
        g.user = u
        return fn(*a, **kw)
    return wrapper


def admin_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        u = current_user()
        if u is None:
            return err("Bạn cần đăng nhập.", 401)
        if u["role"] != "admin":
            return err("Chỉ thủ thư mới có quyền này.", 403)
        g.user = u
        return fn(*a, **kw)
    return wrapper


def clean(value, maxlen=200):
    return (value or "").strip()[:maxlen] if isinstance(value, str) else ""


def user_public(u):
    return {
        "id": u["id"], "username": u["username"], "full_name": u["full_name"],
        "email": u["email"] or "", "student_id": u["student_id"] or "", "role": u["role"],
    }


BOOK_SELECT = """
SELECT b.*, b.copies - COALESCE((SELECT COUNT(*) FROM loans l WHERE l.book_id=b.id AND l.status='borrowing'),0) AS available
FROM books b
"""


def book_dict(r):
    d = dict(r)
    d["available"] = max(d["available"], 0)
    return d


def loan_dict(r):
    d = dict(r)
    d["overdue"] = bool(d.get("status") == "borrowing" and d.get("due_date") and d["due_date"] < today_str())
    return d


LOAN_SELECT = """
SELECT l.*, b.title AS book_title, b.author AS book_author, b.location AS book_location,
       u.full_name AS user_name, u.username AS user_username, u.student_id AS user_student_id
FROM loans l JOIN books b ON b.id=l.book_id JOIN users u ON u.id=l.user_id
"""


# ------------------------------------------------------------- pages
@app.route("/")
def index():
    return send_from_directory(os.path.join(BASE_DIR, "static"), "index.html")


@app.after_request
def security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# ------------------------------------------------------------- auth
@app.post("/api/register")
def register():
    d = request.get_json(silent=True) or {}
    username = clean(d.get("username"), 40)
    full_name = clean(d.get("full_name"), 100)
    email = clean(d.get("email"), 120)
    student_id = clean(d.get("student_id"), 30)
    password = d.get("password") or ""
    if not re.fullmatch(r"[A-Za-z0-9_.-]{3,40}", username):
        return err("Tên đăng nhập gồm 3-40 ký tự: chữ không dấu, số, dấu . _ -")
    if len(full_name) < 2:
        return err("Vui lòng nhập họ và tên.")
    if email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return err("Email không hợp lệ.")
    if len(password) < 6:
        return err("Mật khẩu cần ít nhất 6 ký tự.")
    db = get_db()
    try:
        cur = db.execute(
            "INSERT INTO users (username, full_name, email, student_id, password_hash, role, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (username, full_name, email, student_id, generate_password_hash(password), "reader", now_str()),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return err("Tên đăng nhập đã tồn tại.", 409)
    session.clear()
    session.permanent = True
    session["uid"] = cur.lastrowid
    return jsonify(user_public(db.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()))


@app.post("/api/login")
def login():
    d = request.get_json(silent=True) or {}
    username = clean(d.get("username"), 40)
    password = d.get("password") or ""
    u = get_db().execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if u is None or not check_password_hash(u["password_hash"], password):
        return err("Sai tên đăng nhập hoặc mật khẩu.", 401)
    if not u["active"]:
        return err("Tài khoản đã bị khóa. Vui lòng liên hệ thủ thư.", 403)
    session.clear()
    session.permanent = True
    session["uid"] = u["id"]
    return jsonify(user_public(u))


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/me")
def me():
    u = current_user()
    return jsonify({"user": user_public(u) if u else None, "loan_days": LOAN_DAYS, "max_loans": MAX_ACTIVE_LOANS})


@app.post("/api/me/password")
@login_required
def change_password():
    d = request.get_json(silent=True) or {}
    if not check_password_hash(g.user["password_hash"], d.get("old_password") or ""):
        return err("Mật khẩu hiện tại không đúng.", 403)
    new = d.get("new_password") or ""
    if len(new) < 6:
        return err("Mật khẩu mới cần ít nhất 6 ký tự.")
    db = get_db()
    db.execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(new), g.user["id"]))
    db.commit()
    return jsonify({"ok": True})


# ------------------------------------------------------------- catalog (công khai)
@app.get("/api/books")
def list_books():
    q = clean(request.args.get("q"), 100)
    category = clean(request.args.get("category"), 100)
    only_available = request.args.get("available") == "1"
    page = max(int(request.args.get("page", 1) or 1), 1)
    per = min(max(int(request.args.get("per", 12) or 12), 1), 100)
    where, args = [], []
    if q:
        like = f"%{q}%"
        where.append("(b.title LIKE ? OR b.author LIKE ? OR b.isbn LIKE ? OR b.publisher LIKE ?)")
        args += [like, like, like, like]
    if category:
        where.append("b.category = ?")
        args.append(category)
    sql_where = (" WHERE " + " AND ".join(where)) if where else ""
    base = f"SELECT * FROM ({BOOK_SELECT}) b{sql_where}"
    if only_available:
        base += (" AND" if where else " WHERE") + " b.available > 0"
    db = get_db()
    total = db.execute(f"SELECT COUNT(*) FROM ({base})", args).fetchone()[0]
    rows = db.execute(f"{base} ORDER BY b.title COLLATE NOCASE LIMIT ? OFFSET ?", args + [per, (page - 1) * per]).fetchall()
    return jsonify({"items": [book_dict(r) for r in rows], "total": total, "page": page, "per": per})


@app.get("/api/categories")
def categories():
    rows = get_db().execute("SELECT DISTINCT category FROM books WHERE category<>'' ORDER BY category COLLATE NOCASE").fetchall()
    return jsonify([r[0] for r in rows])


@app.get("/api/books/<int:book_id>")
def get_book(book_id):
    r = get_db().execute(f"SELECT * FROM ({BOOK_SELECT}) b WHERE b.id=?", (book_id,)).fetchone()
    if r is None:
        return err("Không tìm thấy sách.", 404)
    return jsonify(book_dict(r))


# ------------------------------------------------------------- bạn đọc
@app.post("/api/loans")
@login_required
def request_loan():
    if g.user["role"] != "reader":
        return err("Tài khoản thủ thư không đăng ký mượn sách.", 403)
    d = request.get_json(silent=True) or {}
    try:
        book_id = int(d.get("book_id"))
    except (TypeError, ValueError):
        return err("Thiếu mã sách.")
    db = get_db()
    book = db.execute(f"SELECT * FROM ({BOOK_SELECT}) b WHERE b.id=?", (book_id,)).fetchone()
    if book is None:
        return err("Không tìm thấy sách.", 404)
    if book["available"] <= 0:
        return err("Sách này hiện đã được mượn hết.", 409)
    dup = db.execute(
        "SELECT 1 FROM loans WHERE user_id=? AND book_id=? AND status IN ('pending','borrowing')",
        (g.user["id"], book_id)).fetchone()
    if dup:
        return err("Bạn đã đăng ký hoặc đang mượn cuốn này.", 409)
    active = db.execute(
        "SELECT COUNT(*) FROM loans WHERE user_id=? AND status IN ('pending','borrowing')", (g.user["id"],)).fetchone()[0]
    if active >= MAX_ACTIVE_LOANS:
        return err(f"Bạn chỉ được đăng ký/mượn tối đa {MAX_ACTIVE_LOANS} cuốn cùng lúc.", 409)
    overdue = db.execute(
        "SELECT COUNT(*) FROM loans WHERE user_id=? AND status='borrowing' AND due_date < ?",
        (g.user["id"], today_str())).fetchone()[0]
    if overdue:
        return err("Bạn đang có sách quá hạn. Vui lòng trả sách trước khi mượn thêm.", 409)
    db.execute("INSERT INTO loans (book_id, user_id, status, requested_at, note) VALUES (?,?,?,?,?)",
               (book_id, g.user["id"], "pending", now_str(), clean(d.get("note"), 300)))
    db.commit()
    return jsonify({"ok": True})


@app.get("/api/loans/mine")
@login_required
def my_loans():
    rows = get_db().execute(f"{LOAN_SELECT} WHERE l.user_id=? ORDER BY l.id DESC", (g.user["id"],)).fetchall()
    return jsonify([loan_dict(r) for r in rows])


@app.post("/api/loans/<int:loan_id>/cancel")
@login_required
def cancel_loan(loan_id):
    db = get_db()
    r = db.execute("SELECT * FROM loans WHERE id=? AND user_id=?", (loan_id, g.user["id"])).fetchone()
    if r is None:
        return err("Không tìm thấy yêu cầu.", 404)
    if r["status"] != "pending":
        return err("Chỉ hủy được yêu cầu đang chờ duyệt.", 409)
    db.execute("UPDATE loans SET status='cancelled' WHERE id=?", (loan_id,))
    db.commit()
    return jsonify({"ok": True})


# ------------------------------------------------------------- thủ thư: mượn / trả
@app.get("/api/admin/loans")
@admin_required
def admin_loans():
    status = clean(request.args.get("status"), 20)
    q = clean(request.args.get("q"), 100)
    where, args = [], []
    if status == "overdue":
        where.append("l.status='borrowing' AND l.due_date < ?")
        args.append(today_str())
    elif status:
        where.append("l.status=?")
        args.append(status)
    if q:
        like = f"%{q}%"
        where.append("(b.title LIKE ? OR u.full_name LIKE ? OR u.username LIKE ? OR u.student_id LIKE ?)")
        args += [like] * 4
    sql = LOAN_SELECT + ((" WHERE " + " AND ".join(where)) if where else "") + " ORDER BY l.id DESC LIMIT 500"
    return jsonify([loan_dict(r) for r in get_db().execute(sql, args).fetchall()])


@app.post("/api/admin/loans/<int:loan_id>/approve")
@admin_required
def approve_loan(loan_id):
    d = request.get_json(silent=True) or {}
    try:
        days = min(max(int(d.get("days", LOAN_DAYS)), 1), 120)
    except (TypeError, ValueError):
        days = LOAN_DAYS
    db = get_db()
    loan = db.execute("SELECT * FROM loans WHERE id=?", (loan_id,)).fetchone()
    if loan is None:
        return err("Không tìm thấy yêu cầu.", 404)
    if loan["status"] != "pending":
        return err("Yêu cầu này không còn ở trạng thái chờ duyệt.", 409)
    book = db.execute(f"SELECT * FROM ({BOOK_SELECT}) b WHERE b.id=?", (loan["book_id"],)).fetchone()
    if book["available"] <= 0:
        return err("Không còn bản nào để cho mượn.", 409)
    due = (date.today() + timedelta(days=days)).isoformat()
    db.execute("UPDATE loans SET status='borrowing', approved_at=?, due_date=? WHERE id=?", (now_str(), due, loan_id))
    db.commit()
    return jsonify({"ok": True, "due_date": due})


@app.post("/api/admin/loans/<int:loan_id>/reject")
@admin_required
def reject_loan(loan_id):
    d = request.get_json(silent=True) or {}
    db = get_db()
    r = db.execute("SELECT status FROM loans WHERE id=?", (loan_id,)).fetchone()
    if r is None:
        return err("Không tìm thấy yêu cầu.", 404)
    if r["status"] != "pending":
        return err("Yêu cầu này không còn ở trạng thái chờ duyệt.", 409)
    db.execute("UPDATE loans SET status='rejected', note=? WHERE id=?", (clean(d.get("note"), 300), loan_id))
    db.commit()
    return jsonify({"ok": True})


@app.post("/api/admin/loans/<int:loan_id>/return")
@admin_required
def return_loan(loan_id):
    db = get_db()
    r = db.execute("SELECT status FROM loans WHERE id=?", (loan_id,)).fetchone()
    if r is None:
        return err("Không tìm thấy phiếu mượn.", 404)
    if r["status"] != "borrowing":
        return err("Phiếu này không ở trạng thái đang mượn.", 409)
    db.execute("UPDATE loans SET status='returned', returned_at=? WHERE id=?", (now_str(), loan_id))
    db.commit()
    return jsonify({"ok": True})


@app.post("/api/admin/loans/<int:loan_id>/extend")
@admin_required
def extend_loan(loan_id):
    d = request.get_json(silent=True) or {}
    try:
        days = min(max(int(d.get("days", 7)), 1), 60)
    except (TypeError, ValueError):
        days = 7
    db = get_db()
    r = db.execute("SELECT status, due_date FROM loans WHERE id=?", (loan_id,)).fetchone()
    if r is None or r["status"] != "borrowing":
        return err("Chỉ gia hạn được phiếu đang mượn.", 409)
    base = max(date.fromisoformat(r["due_date"]), date.today())
    due = (base + timedelta(days=days)).isoformat()
    db.execute("UPDATE loans SET due_date=? WHERE id=?", (due, loan_id))
    db.commit()
    return jsonify({"ok": True, "due_date": due})


# ------------------------------------------------------------- thủ thư: sách
def parse_book(d):
    title = clean(d.get("title"), 250)
    if not title:
        return None, "Vui lòng nhập tên sách."
    try:
        copies = int(d.get("copies", 1))
        if copies < 0 or copies > 9999:
            raise ValueError
    except (TypeError, ValueError):
        return None, "Số bản không hợp lệ."
    year = d.get("year")
    try:
        year = int(year) if str(year or "").strip() else None
        if year is not None and not (1000 <= year <= 2100):
            raise ValueError
    except (TypeError, ValueError):
        return None, "Năm xuất bản không hợp lệ."
    return {
        "title": title, "author": clean(d.get("author"), 200), "category": clean(d.get("category"), 100),
        "isbn": clean(d.get("isbn"), 30), "publisher": clean(d.get("publisher"), 150), "year": year,
        "copies": copies, "location": clean(d.get("location"), 60), "description": clean(d.get("description"), 2000),
    }, None


@app.post("/api/admin/books")
@admin_required
def add_book():
    b, e = parse_book(request.get_json(silent=True) or {})
    if e:
        return err(e)
    db = get_db()
    cur = db.execute(
        "INSERT INTO books (title, author, category, isbn, publisher, year, copies, location, description, created_at)"
        " VALUES (:title,:author,:category,:isbn,:publisher,:year,:copies,:location,:description,:created_at)",
        {**b, "created_at": now_str()})
    db.commit()
    return jsonify({"ok": True, "id": cur.lastrowid})


@app.put("/api/admin/books/<int:book_id>")
@admin_required
def update_book(book_id):
    b, e = parse_book(request.get_json(silent=True) or {})
    if e:
        return err(e)
    db = get_db()
    if db.execute("SELECT 1 FROM books WHERE id=?", (book_id,)).fetchone() is None:
        return err("Không tìm thấy sách.", 404)
    borrowed = db.execute("SELECT COUNT(*) FROM loans WHERE book_id=? AND status='borrowing'", (book_id,)).fetchone()[0]
    if b["copies"] < borrowed:
        return err(f"Đang có {borrowed} bản cho mượn, số bản không thể nhỏ hơn con số này.", 409)
    db.execute(
        "UPDATE books SET title=:title, author=:author, category=:category, isbn=:isbn, publisher=:publisher,"
        " year=:year, copies=:copies, location=:location, description=:description WHERE id=:id",
        {**b, "id": book_id})
    db.commit()
    return jsonify({"ok": True})


@app.delete("/api/admin/books/<int:book_id>")
@admin_required
def delete_book(book_id):
    db = get_db()
    if db.execute("SELECT COUNT(*) FROM loans WHERE book_id=? AND status IN ('pending','borrowing')", (book_id,)).fetchone()[0]:
        return err("Sách đang có yêu cầu/phiếu mượn chưa xử lý, không thể xóa.", 409)
    if db.execute("SELECT COUNT(*) FROM loans WHERE book_id=?", (book_id,)).fetchone()[0]:
        return err("Sách đã có lịch sử mượn nên không xóa được. Hãy đặt số bản về 0 để ngừng cho mượn.", 409)
    db.execute("DELETE FROM books WHERE id=?", (book_id,))
    db.commit()
    return jsonify({"ok": True})


CSV_FIELDS = ["title", "author", "category", "isbn", "publisher", "year", "copies", "location", "description"]
CSV_ALIASES = {
    "tên sách": "title", "tiêu đề": "title", "tác giả": "author", "thể loại": "category", "isbn": "isbn",
    "nhà xuất bản": "publisher", "nxb": "publisher", "năm": "year", "năm xuất bản": "year",
    "số bản": "copies", "số lượng": "copies", "vị trí": "location", "mô tả": "description",
}


@app.post("/api/admin/books/import")
@admin_required
def import_books():
    f = request.files.get("file")
    if f is None:
        return err("Chưa chọn tệp CSV.")
    raw = f.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return err("Tệp phải lưu dạng CSV UTF-8.")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        return err("Tệp CSV trống.")
    mapping = {}
    for name in reader.fieldnames:
        key = (name or "").strip().lower().lstrip("﻿")
        key = CSV_ALIASES.get(key, key)
        if key in CSV_FIELDS:
            mapping[name] = key
    if "title" not in mapping.values():
        return err("Không thấy cột tên sách (title / Tên sách).")
    db = get_db()
    added, skipped = 0, []
    for i, row in enumerate(reader, start=2):
        data = {mapping[k]: v for k, v in row.items() if k in mapping}
        if not str(data.get("copies", "")).strip():
            data["copies"] = 1
        b, e = parse_book(data)
        if e:
            skipped.append(f"Dòng {i}: {e}")
            continue
        db.execute(
            "INSERT INTO books (title, author, category, isbn, publisher, year, copies, location, description, created_at)"
            " VALUES (:title,:author,:category,:isbn,:publisher,:year,:copies,:location,:description,:created_at)",
            {**b, "created_at": now_str()})
        added += 1
    db.commit()
    return jsonify({"ok": True, "added": added, "skipped": skipped[:20], "skipped_count": len(skipped)})


# ------------------------------------------------------------- thủ thư: bạn đọc & thống kê
@app.get("/api/admin/users")
@admin_required
def admin_users():
    q = clean(request.args.get("q"), 100)
    where, args = "WHERE u.role='reader'", []
    if q:
        like = f"%{q}%"
        where += " AND (u.full_name LIKE ? OR u.username LIKE ? OR u.student_id LIKE ? OR u.email LIKE ?)"
        args = [like] * 4
    rows = get_db().execute(
        "SELECT u.id, u.username, u.full_name, u.email, u.student_id, u.active, u.created_at,"
        " (SELECT COUNT(*) FROM loans l WHERE l.user_id=u.id AND l.status='borrowing') AS borrowing,"
        " (SELECT COUNT(*) FROM loans l WHERE l.user_id=u.id AND l.status='borrowing' AND l.due_date < ?) AS overdue,"
        " (SELECT COUNT(*) FROM loans l WHERE l.user_id=u.id) AS total_loans"
        f" FROM users u {where} ORDER BY u.full_name COLLATE NOCASE LIMIT 500",
        [today_str()] + args).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/admin/users/<int:user_id>/toggle")
@admin_required
def toggle_user(user_id):
    db = get_db()
    r = db.execute("SELECT role, active FROM users WHERE id=?", (user_id,)).fetchone()
    if r is None or r["role"] != "reader":
        return err("Không tìm thấy bạn đọc.", 404)
    db.execute("UPDATE users SET active=? WHERE id=?", (0 if r["active"] else 1, user_id))
    db.commit()
    return jsonify({"ok": True, "active": 0 if r["active"] else 1})


@app.post("/api/admin/users/<int:user_id>/reset-password")
@admin_required
def reset_password(user_id):
    d = request.get_json(silent=True) or {}
    new = d.get("new_password") or ""
    if len(new) < 6:
        return err("Mật khẩu mới cần ít nhất 6 ký tự.")
    db = get_db()
    r = db.execute("SELECT role FROM users WHERE id=?", (user_id,)).fetchone()
    if r is None or r["role"] != "reader":
        return err("Không tìm thấy bạn đọc.", 404)
    db.execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(new), user_id))
    db.commit()
    return jsonify({"ok": True})


@app.get("/api/admin/stats")
@admin_required
def stats():
    db = get_db()
    one = lambda sql, *a: db.execute(sql, a).fetchone()[0]
    top = db.execute(
        "SELECT b.title, COUNT(*) AS n FROM loans l JOIN books b ON b.id=l.book_id"
        " WHERE l.status IN ('borrowing','returned') GROUP BY b.id ORDER BY n DESC, b.title LIMIT 5").fetchall()
    return jsonify({
        "titles": one("SELECT COUNT(*) FROM books"),
        "copies": one("SELECT COALESCE(SUM(copies),0) FROM books"),
        "borrowing": one("SELECT COUNT(*) FROM loans WHERE status='borrowing'"),
        "pending": one("SELECT COUNT(*) FROM loans WHERE status='pending'"),
        "overdue": one("SELECT COUNT(*) FROM loans WHERE status='borrowing' AND due_date < ?", today_str()),
        "readers": one("SELECT COUNT(*) FROM users WHERE role='reader'"),
        "top_books": [{"title": r["title"], "count": r["n"]} for r in top],
    })


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), debug=os.environ.get("FLASK_DEBUG") == "1")
