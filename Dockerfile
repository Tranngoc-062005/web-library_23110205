FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV DATA_DIR=/data PORT=8000
VOLUME /data
EXPOSE 8000
# SQLite chỉ nên ghi từ một tiến trình chính nên dùng 1 worker + nhiều thread.
CMD ["gunicorn", "-w", "1", "--threads", "8", "-b", "0.0.0.0:8000", "app:app"]
