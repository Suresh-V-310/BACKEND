FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential gcc g++ make curl git sqlite3 libffi-dev \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
      requests numpy pandas matplotlib scipy scikit-learn flask django fastapi uvicorn

RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir tensorflow || true

RUN useradd -m compiler
USER compiler
WORKDIR /workspace

CMD ["python", "--version"]
