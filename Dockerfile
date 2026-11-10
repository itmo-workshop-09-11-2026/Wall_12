FROM python:3.12-slim

WORKDIR /app
COPY main.py ./main.py
COPY site ./site
RUN mkdir -p /app/data

ENV HOST=0.0.0.0
ENV PORT=8000
EXPOSE 8000

CMD ["python", "main.py"]
