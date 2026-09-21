FROM python:3.13-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./
COPY core ./core
COPY handlers ./handlers
COPY storage ./storage

ENV DB_PATH=/data/stopspam.db
VOLUME /data
CMD ["python", "-u", "bot.py"]
