# Hệ thống mượn sách thư viện

Web đăng ký mượn sách cho thư viện quy mô vài trăm đầu sách. Giao diện hoàn toàn bằng tiếng Việt, có hai vai trò:

- **Bạn đọc**: đăng ký tài khoản, tra cứu sách, đăng ký mượn, theo dõi trạng thái, hủy yêu cầu, đổi mật khẩu.
- **Thủ thư (admin)**: duyệt/từ chối yêu cầu, giao sách, nhận trả, gia hạn, xem sách quá hạn, quản lý sách (thêm/sửa/xóa, nhập CSV), quản lý bạn đọc (khóa, đặt lại mật khẩu), xem thống kê.

**Quy trình mượn:** bạn đọc gửi yêu cầu (*Chờ duyệt*) → thủ thư duyệt & giao sách tại quầy (*Đang mượn*, có hạn trả) → thủ thư nhận trả (*Đã trả*).

## Chạy thử trên máy

```bash
pip install -r requirements.txt
SEED_SAMPLE=1 ADMIN_PASSWORD='MatKhauCuaBan' python app.py
```

Mở http://localhost:8000. Đăng nhập thủ thư: `admin` / mật khẩu bạn đặt ở `ADMIN_PASSWORD`.
`SEED_SAMPLE=1` nạp 10 sách mẫu (chỉ khi kho sách đang trống) — bỏ biến này khi chạy thật.
Nếu không đặt `ADMIN_PASSWORD`, hệ thống tự sinh mật khẩu và in ra màn hình **một lần duy nhất** ở lần chạy đầu.

## Deploy lên môi trường thật

### Cách 1: Docker (khuyên dùng)

```bash
docker build -t thuvien .
docker run -d --name thuvien -p 8000:8000 \
  -v thuvien-data:/data \
  -e ADMIN_PASSWORD='MatKhauManh' \
  -e COOKIE_SECURE=1 \
  thuvien
```

Dữ liệu nằm trong volume `thuvien-data` (file SQLite), nhớ **sao lưu định kỳ** thư mục này.

### Cách 2: máy chủ Linux trực tiếp

```bash
pip install -r requirements.txt
export DATA_DIR=/var/lib/thuvien ADMIN_PASSWORD='MatKhauManh' COOKIE_SECURE=1
gunicorn -w 1 --threads 8 -b 127.0.0.1:8000 app:app
```

Đặt Nginx/Caddy phía trước để có HTTPS, trỏ về `127.0.0.1:8000`.

> **Lưu ý:** dùng SQLite nên chạy **1 worker** (nhiều thread) như trên. Với vài trăm đầu sách và lượng truy cập của một thư viện trường thì hoàn toàn đủ.
> Một số nền tảng PaaS (Render, Railway…) có ổ đĩa tạm thời — cần gắn **persistent disk/volume** và đặt `DATA_DIR` vào đó, nếu không dữ liệu sẽ mất khi khởi động lại.

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `ADMIN_USER` | `admin` | Tên đăng nhập thủ thư (chỉ dùng lần chạy đầu) |
| `ADMIN_PASSWORD` | tự sinh | Mật khẩu thủ thư (chỉ dùng lần chạy đầu) |
| `SECRET_KEY` | tự sinh, lưu trong `DATA_DIR` | Khóa ký phiên đăng nhập |
| `DATA_DIR` | `./data` | Nơi lưu cơ sở dữ liệu |
| `COOKIE_SECURE` | `0` | Đặt `1` khi chạy sau HTTPS |
| `LOAN_DAYS` | `14` | Số ngày mượn mặc định |
| `MAX_ACTIVE_LOANS` | `5` | Số sách tối đa mỗi bạn đọc (chờ duyệt + đang mượn) |
| `SEED_SAMPLE` | — | `1` để nạp sách mẫu khi kho trống |
| `PORT` | `8000` | Cổng khi chạy `python app.py` |

## Nhập sách hàng loạt

Vào **Quản lý sách → Nhập từ CSV**. Tệp CSV mã hóa UTF-8, dòng đầu là tên cột (có nút tải tệp mẫu). Cột bắt buộc: *Tên sách*; các cột khác: Tác giả, Thể loại, ISBN, Nhà xuất bản, Năm xuất bản, Số bản, Vị trí, Mô tả. Xuất từ Excel: *Save As → CSV UTF-8*.

## Cấu trúc

```
app.py              # Backend Flask + SQLite (API, phân quyền, nghiệp vụ mượn/trả)
static/index.html   # Khung trang
static/css/style.css
static/js/app.js    # Giao diện (không cần build)
static/img/logo.png # Logo hiển thị ở đầu trang (thay file này nếu cần)
Dockerfile, requirements.txt
```

## Một số quy tắc đã cài sẵn

- Bạn đọc không mượn trùng một cuốn, không mượn vượt hạn mức, không mượn thêm khi đang có sách quá hạn.
- Sách hết bản thì không đăng ký được; số bản còn lại = tổng số bản − số bản đang cho mượn.
- Không xóa được sách đang có yêu cầu/phiếu mượn hoặc đã có lịch sử mượn (đặt số bản về 0 để ngừng cho mượn).
- Mật khẩu được băm (không lưu bản rõ); khóa tài khoản có hiệu lực ngay lập tức.
