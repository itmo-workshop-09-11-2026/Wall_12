from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(url: str, data: dict | None = None):
    body = None if data is None else json.dumps(data).encode("utf-8")
    headers = {"Content-Type": "application/json"} if body is not None else {}
    req = urllib.request.Request(url, data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            raw = response.read()
            content_type = response.headers.get("Content-Type", "")
            return response.status, json.loads(raw) if "json" in content_type else raw
    except urllib.error.HTTPError as error:
        raw = error.read()
        return error.code, json.loads(raw)


def main() -> int:
    port = free_port()
    with tempfile.TemporaryDirectory(prefix="cosmomarket-test-") as temp_dir:
        env = os.environ.copy()
        env["PORT"] = str(port)
        env["HOST"] = "127.0.0.1"
        env["SHOP_DB_PATH"] = str(Path(temp_dir) / "test.sqlite3")
        process = subprocess.Popen(
            [sys.executable, str(ROOT / "main.py")],
            cwd=ROOT,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        base_url = f"http://127.0.0.1:{port}"
        try:
            for _ in range(60):
                if process.poll() is not None:
                    raise RuntimeError("Сервер завершился до начала проверки")
                try:
                    status, page = request(base_url + "/")
                    if status == 200:
                        break
                except (urllib.error.URLError, TimeoutError, ConnectionError):
                    time.sleep(0.15)
            else:
                raise RuntimeError("Не удалось дождаться запуска сервера")

            assert "КосмоМаркет".encode("utf-8") in page, "главная страница не содержит заголовок магазина"
            status, products = request(base_url + "/api/products")
            assert status == 200 and len(products) >= 3, f"каталог: HTTP {status}, ответ {products}"

            status, found = request(base_url + "/api/products?" + urlencode({"q": "лун"}))
            assert status == 200 and any("Лунный" in product["name"] for product in found), f"поиск: HTTP {status}, ответ {found}"

            status, order = request(base_url + "/api/orders", {
                "items": [{"productId": "nebula-mug", "quantity": 1}],
                "promoCode": "SPACE10",
            })
            assert status == 201, order
            assert order["subtotal"] == 790 and order["discount"] == 79 and order["total"] == 711, f"неверный расчёт заказа: {order}"

            status, error = request(base_url + "/api/orders", {
                "items": [{"productId": "unknown-product", "quantity": 1}]
            })
            assert status == 404 and "error" in error, f"ошибка неизвестного товара: {status}, {error}"

            pack = subprocess.run(
                [sys.executable, str(ROOT / "main.py"), "--pack"],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
            archive_path = ROOT / "shop.zip"
            assert archive_path.exists(), pack.stdout
            with zipfile.ZipFile(archive_path) as archive:
                names = archive.namelist()
                assert "index.html" in names, f"index.html отсутствует в ZIP: {names}"
                assert "app.js" in names, f"app.js отсутствует в ZIP: {names}"
                assert not any(name.startswith("site/") for name in names)

            print("OK: главная страница, API, поиск, заказ, проверка ошибок и ZIP.")
            return 0
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Ошибка проверки: {error}", file=sys.stderr)
        raise SystemExit(1)
