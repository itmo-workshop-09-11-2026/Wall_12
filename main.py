from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import zipfile
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT_DIR = Path(__file__).resolve().parent
SITE_DIR = ROOT_DIR / "site"
DB_PATH = Path(os.environ.get("SHOP_DB_PATH", ROOT_DIR / "data" / "shop.sqlite3"))
ZIP_PATH = ROOT_DIR / "shop.zip"


def connect_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_database() -> None:
    """Create tables and load the demonstration catalog on the first run."""
    with connect_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS products (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                price INTEGER NOT NULL CHECK(price >= 0),
                category TEXT NOT NULL,
                emoji TEXT NOT NULL,
                stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0)
            );

            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                subtotal INTEGER NOT NULL,
                discount INTEGER NOT NULL,
                total INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS order_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
                product_id TEXT NOT NULL,
                product_name TEXT NOT NULL,
                quantity INTEGER NOT NULL,
                unit_price INTEGER NOT NULL
            );
            """
        )
        count = db.execute("SELECT COUNT(*) FROM products").fetchone()[0]
        if count == 0:
            products_file = SITE_DIR / "products.json"
            products = json.loads(products_file.read_text(encoding="utf-8"))
            db.executemany(
                """INSERT INTO products
                   (id, name, description, price, category, emoji, stock)
                   VALUES (:id, :name, :description, :price, :category, :emoji, :stock)""",
                products,
            )


def pack_site() -> Path:
    """Create a standalone ZIP with the contents of site/ at its root."""
    if not SITE_DIR.is_dir():
        raise FileNotFoundError(f"Не найдена папка сайта: {SITE_DIR}")

    with zipfile.ZipFile(ZIP_PATH, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(SITE_DIR.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(SITE_DIR).as_posix())
    return ZIP_PATH


class ShopRequestHandler(SimpleHTTPRequestHandler):
    server_version = "CosmoMarket/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE_DIR), **kwargs)

    def send_json(self, payload: dict | list, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/products":
            self.get_products(parse_qs(parsed.query))
            return
        if parsed.path == "/api/categories":
            with connect_db() as db:
                rows = db.execute(
                    "SELECT DISTINCT category FROM products ORDER BY category COLLATE NOCASE"
                ).fetchall()
            self.send_json([row[0] for row in rows])
            return
        super().do_GET()

    def get_products(self, query: dict[str, list[str]]) -> None:
        search = query.get("q", [""])[0].strip()
        category = query.get("category", [""])[0].strip()
        sql = "SELECT id, name, description, price, category, emoji, stock FROM products WHERE 1=1"
        params: list[str] = []
        if category and category != "all":
            sql += " AND category = ?"
            params.append(category)
        sql += " ORDER BY id"
        with connect_db() as db:
            rows = db.execute(sql, params).fetchall()
        # Python casefold also handles Cyrillic; SQLite's built-in LOWER/LIKE
        # performs case-insensitive matching for ASCII only by default.
        if search:
            needle = search.casefold()
            rows = [row for row in rows if needle in (row["name"] + " " + row["description"]).casefold()]
        self.send_json([dict(row) for row in rows])

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/api/orders":
            self.send_json({"error": "Маршрут не найден"}, 404)
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json({"error": "Некорректный Content-Length"}, 400)
            return
        if content_length <= 0 or content_length > 16_384:
            self.send_json({"error": "Размер запроса должен быть от 1 до 16384 байт"}, 400)
            return

        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            items = payload.get("items") if isinstance(payload, dict) else None
            promo_code = payload.get("promoCode", "") if isinstance(payload, dict) else ""
            if not isinstance(items, list) or not items:
                raise ValueError("Корзина пуста или имеет неверный формат")
            if len(items) > 30:
                raise ValueError("В одном заказе можно указать не более 30 позиций")

            requested: dict[str, int] = {}
            for item in items:
                if not isinstance(item, dict):
                    raise ValueError("Некорректная позиция заказа")
                product_id = item.get("productId")
                quantity = item.get("quantity")
                if not isinstance(product_id, str) or not product_id:
                    raise ValueError("У товара отсутствует корректный productId")
                if isinstance(quantity, bool) or not isinstance(quantity, int) or not 1 <= quantity <= 99:
                    raise ValueError("Количество должно быть целым числом от 1 до 99")
                requested[product_id] = requested.get(product_id, 0) + quantity
                if requested[product_id] > 99:
                    raise ValueError("Суммарное количество одного товара не может превышать 99")
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            self.send_json({"error": str(error) or "Некорректный JSON"}, 400)
            return

        try:
            with connect_db() as db:
                # Serialize order creation so two simultaneous orders cannot oversell stock.
                db.execute("BEGIN IMMEDIATE")
                selected: list[tuple[sqlite3.Row, int]] = []
                subtotal = 0
                for product_id, quantity in requested.items():
                    product = db.execute(
                        "SELECT id, name, price, stock FROM products WHERE id = ?", (product_id,)
                    ).fetchone()
                    if product is None:
                        raise LookupError(f"Товар с ID '{product_id}' не найден")
                    if quantity > product["stock"]:
                        raise OverflowError(
                            f"Недостаточно товара «{product['name']}»: доступно {product['stock']} шт."
                        )
                    selected.append((product, quantity))
                    subtotal += product["price"] * quantity

                discount = round(subtotal * 0.10) if str(promo_code).strip().upper() == "SPACE10" else 0
                total = subtotal - discount
                cursor = db.execute(
                    "INSERT INTO orders (created_at, subtotal, discount, total) VALUES (?, ?, ?, ?)",
                    (datetime.now(timezone.utc).isoformat(timespec="seconds"), subtotal, discount, total),
                )
                order_id = cursor.lastrowid
                for product, quantity in selected:
                    db.execute(
                        "INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price) "
                        "VALUES (?, ?, ?, ?, ?)",
                        (order_id, product["id"], product["name"], quantity, product["price"]),
                    )
                    db.execute(
                        "UPDATE products SET stock = stock - ? WHERE id = ?",
                        (quantity, product["id"]),
                    )
            self.send_json(
                {"orderId": order_id, "subtotal": subtotal, "discount": discount, "total": total},
                201,
            )
        except LookupError as error:
            self.send_json({"error": str(error)}, 404)
        except OverflowError as error:
            self.send_json({"error": str(error)}, 409)
        except sqlite3.Error:
            self.send_json({"error": "Не удалось сохранить заказ. Попробуйте ещё раз."}, 500)

    def log_message(self, format: str, *args) -> None:
        # Keep the terminal readable: log only normal HTTP requests, without noisy details.
        super().log_message(format, *args)


def run_server(host: str, port: int) -> None:
    initialize_database()
    server = ThreadingHTTPServer((host, port), ShopRequestHandler)
    print("КосмоМаркет запущен!")
    print(f"Откройте сайт: http://{host if host != '0.0.0.0' else '127.0.0.1'}:{server.server_port}")
    print("Для остановки нажмите Ctrl+C.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nСервер остановлен.")
    finally:
        server.server_close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Локальный сервер учебного магазина КосмоМаркет")
    parser.add_argument("--pack", action="store_true", help="создать самостоятельный shop.zip из папки site")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    args = parser.parse_args()

    if args.pack:
        archive = pack_site()
        print(f"Архив создан: {archive}")
        print("Внутри ZIP index.html находится в корне и сайт работает без Python API.")
        return 0

    if not 1 <= args.port <= 65535:
        parser.error("Порт должен быть в диапазоне от 1 до 65535")
    run_server(args.host, args.port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
