/*
 * Ключ localStorage содержит номер команды. Перед сдачей замените team07,
 * например, на team12, чтобы корзины разных команд не пересекались.
 */
const TEAM_KEY = "team07";
const CART_KEY = `${TEAM_KEY}:cart:v1`;
const FAVORITES_KEY = `${TEAM_KEY}:favorites:v1`;
const PROMO_CODE = "SPACE10";

const state = {
  allProducts: [],
  visibleProducts: [],
  cart: readStorage(CART_KEY, {}),
  favorites: readStorage(FAVORITES_KEY, []),
  category: "all",
  query: "",
  sort: "featured",
  favoritesOnly: false,
  promoApplied: false,
  backendAvailable: false,
  requestNumber: 0
};

const $ = (selector) => document.querySelector(selector);
const productGrid = $("#product-grid");
const categoryList = $("#category-list");

function readStorage(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function saveStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    showNotice("Браузер не разрешил сохранить данные на этом устройстве.", true);
  }
}

function formatPrice(value) {
  return `${Number(value).toLocaleString("ru-RU")} ₽`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]);
}

async function loadCatalog() {
  try {
    const response = await fetch("/api/products");
    if (!response.ok) throw new Error("API недоступно");
    state.allProducts = await response.json();
    state.backendAvailable = true;
  } catch {
    try {
      const response = await fetch("./products.json");
      if (!response.ok) throw new Error("Не удалось загрузить products.json");
      state.allProducts = await response.json();
      state.backendAvailable = false;
    } catch {
      productGrid.innerHTML = '<p class="load-error">Не удалось загрузить каталог. Проверьте запуск сайта.</p>';
      $("#results-count").textContent = "Ошибка загрузки";
      return;
    }
  }
  renderCategories();
  await refreshProducts();
  renderCart();
  renderFavoritesCount();
}

function renderCategories() {
  const categories = [...new Set(state.allProducts.map((product) => product.category))].sort();
  const buttons = [{ id: "all", label: "Все товары" }, ...categories.map((name) => ({ id: name, label: name }))];
  categoryList.innerHTML = buttons.map((item) => `
    <button type="button" class="category-button ${state.category === item.id ? "active" : ""}"
      data-category="${escapeHtml(item.id)}" aria-pressed="${state.category === item.id}">${escapeHtml(item.label)}</button>
  `).join("");
}

async function refreshProducts() {
  const currentRequest = ++state.requestNumber;
  let products = state.allProducts;
  if (state.backendAvailable) {
    const params = new URLSearchParams();
    if (state.query) params.set("q", state.query);
    if (state.category !== "all") params.set("category", state.category);
    try {
      const response = await fetch(`/api/products?${params.toString()}`);
      if (!response.ok) throw new Error("Ошибка API");
      products = await response.json();
    } catch {
      state.backendAvailable = false;
    }
  }
  if (!state.backendAvailable) {
    const query = state.query.toLocaleLowerCase("ru-RU");
    products = state.allProducts.filter((product) => {
      const matchesQuery = !query || `${product.name} ${product.description}`.toLocaleLowerCase("ru-RU").includes(query);
      const matchesCategory = state.category === "all" || product.category === state.category;
      return matchesQuery && matchesCategory;
    });
  }
  if (currentRequest !== state.requestNumber) return;
  if (state.favoritesOnly) products = products.filter((product) => state.favorites.includes(product.id));
  if (state.sort === "asc") products.sort((a, b) => a.price - b.price);
  if (state.sort === "desc") products.sort((a, b) => b.price - a.price);
  state.visibleProducts = products;
  renderProducts();
}

function renderProducts() {
  const products = state.visibleProducts;
  $("#results-count").textContent = `${products.length} ${pluralize(products.length, "находка", "находки", "находок")}`;
  $("#products-empty").classList.toggle("hidden", products.length !== 0);
  productGrid.classList.toggle("hidden", products.length === 0);
  productGrid.innerHTML = products.map((product, index) => {
    const isFavorite = state.favorites.includes(product.id);
    const stockText = product.stock === 0 ? "Нет в наличии" : `В наличии: ${product.stock}`;
    const stockClass = product.stock > 0 && product.stock <= 5 ? "low" : "";
    return `
      <article class="product-card">
        <div class="product-visual">
          <span class="product-index">OBJECT / ${String(index + 1).padStart(2, "0")}</span>
          <span class="product-emoji" aria-hidden="true">${escapeHtml(product.emoji)}</span>
          <span class="stock-label ${stockClass}">${stockText}</span>
          <button class="favorite-button ${isFavorite ? "active" : ""}" type="button"
            data-favorite="${escapeHtml(product.id)}" aria-label="${isFavorite ? "Убрать из избранного" : "Добавить в избранное"}"
            aria-pressed="${isFavorite}">${isFavorite ? "♥" : "♡"}</button>
        </div>
        <div class="product-info">
          <div class="product-category">${escapeHtml(product.category)}</div>
          <h3 class="product-name">${escapeHtml(product.name)}</h3>
          <p class="product-description">${escapeHtml(product.description)}</p>
          <div class="product-bottom"><span class="product-price">${formatPrice(product.price)}</span>
            <button class="add-button" type="button" data-add="${escapeHtml(product.id)}" ${product.stock < 1 ? "disabled" : ""}>
              ${product.stock < 1 ? "Нет в наличии" : "＋ Добавить"}
            </button>
          </div>
        </div>
      </article>`;
  }).join("");
}

function pluralize(number, one, few, many) {
  const n = Math.abs(number) % 100;
  const last = n % 10;
  if (n > 10 && n < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

function addToCart(productId) {
  const product = state.allProducts.find((item) => item.id === productId);
  if (!product || product.stock < 1) return;
  const currentQuantity = Number(state.cart[productId] || 0);
  if (currentQuantity >= product.stock) {
    showNotice(`Больше товара «${product.name}» сейчас нет в наличии.`, true);
    return;
  }
  state.cart[productId] = currentQuantity + 1;
  saveStorage(CART_KEY, state.cart);
  renderCart();
  showNotice(`«${product.name}» добавлен в корзину.`);
}

function changeQuantity(productId, difference) {
  const product = state.allProducts.find((item) => item.id === productId);
  if (!product) return;
  const next = Number(state.cart[productId] || 0) + difference;
  if (next <= 0) delete state.cart[productId];
  else if (next <= product.stock) state.cart[productId] = next;
  else showNotice(`Доступно только ${product.stock} шт.`, true);
  saveStorage(CART_KEY, state.cart);
  renderCart();
}

function removeFromCart(productId) {
  delete state.cart[productId];
  saveStorage(CART_KEY, state.cart);
  renderCart();
}

function cartEntries() {
  return Object.entries(state.cart).map(([id, quantity]) => {
    const product = state.allProducts.find((item) => item.id === id);
    return product ? { ...product, quantity: Number(quantity) } : null;
  }).filter((item) => item && item.quantity > 0);
}

function calculateTotals() {
  const subtotal = cartEntries().reduce((sum, item) => sum + item.price * item.quantity, 0);
  const discount = state.promoApplied ? Math.round(subtotal * 0.10) : 0;
  return { subtotal, discount, total: subtotal - discount };
}

function renderCart() {
  const entries = cartEntries();
  const count = entries.reduce((sum, item) => sum + item.quantity, 0);
  const { subtotal, discount, total } = calculateTotals();
  $("#header-cart-count").textContent = count;
  $("#cart-heading-count").textContent = `${entries.length} ${pluralize(entries.length, "позиция", "позиции", "позиций")}`;
  $("#subtotal").textContent = formatPrice(subtotal);
  $("#discount").textContent = `−${formatPrice(discount)}`;
  $("#total").textContent = formatPrice(total);
  $("#checkout-button").disabled = entries.length === 0;

  if (entries.length === 0) {
    $("#cart-items").innerHTML = `<div class="cart-empty"><span>🛸</span><b>Пока здесь пусто</b><p>Добавь что-нибудь из каталога — и полетели!</p><a href="#catalog">Перейти к находкам ↗</a></div>`;
    state.promoApplied = false;
    $("#promo-input").value = "";
    setPromoMessage("Попробуй SPACE10 — минус 10%.");
    $("#discount").textContent = "−0 ₽";
    $("#total").textContent = "0 ₽";
    return;
  }

  $("#cart-items").innerHTML = entries.map((item) => `
    <div class="cart-item">
      <div class="cart-item-visual" aria-hidden="true">${escapeHtml(item.emoji)}</div>
      <div><div class="cart-item-name">${escapeHtml(item.name)}</div><div class="cart-item-price">${formatPrice(item.price)} / шт.</div></div>
      <div class="quantity-control" aria-label="Количество товара ${escapeHtml(item.name)}">
        <button type="button" data-quantity="${escapeHtml(item.id)}" data-delta="-1" aria-label="Уменьшить количество">−</button>
        <span>${item.quantity}</span>
        <button type="button" data-quantity="${escapeHtml(item.id)}" data-delta="1" aria-label="Увеличить количество">＋</button>
      </div>
      <div class="cart-item-total">${formatPrice(item.price * item.quantity)}</div>
      <button class="remove-button" type="button" data-remove="${escapeHtml(item.id)}" aria-label="Удалить ${escapeHtml(item.name)}">×</button>
    </div>`).join("");
}

function setPromoMessage(message, type = "") {
  const element = $("#promo-message");
  element.textContent = message;
  element.className = `promo-message ${type}`;
}

function applyPromo() {
  const code = $("#promo-input").value.trim().toUpperCase();
  if (code === PROMO_CODE) {
    state.promoApplied = true;
    setPromoMessage("Промокод применён — скидка 10% активна.", "success");
  } else {
    state.promoApplied = false;
    setPromoMessage("Такого промокода нет. Проверь написание.", "error");
  }
  renderCart();
  if (state.promoApplied) setPromoMessage("Промокод применён — скидка 10% активна.", "success");
}

function toggleFavorite(productId) {
  if (state.favorites.includes(productId)) state.favorites = state.favorites.filter((id) => id !== productId);
  else state.favorites.push(productId);
  saveStorage(FAVORITES_KEY, state.favorites);
  renderFavoritesCount();
  refreshProducts();
}

function renderFavoritesCount() {
  $("#favorites-count").textContent = state.favorites.length;
  $("#favorites-toggle").classList.toggle("active", state.favoritesOnly);
  $("#favorites-toggle").setAttribute("aria-pressed", String(state.favoritesOnly));
  $("#favorites-toggle span").textContent = state.favoritesOnly ? "Все товары" : "Избранное";
}

function showNotice(message, isError = false) {
  const notice = $("#order-notice");
  notice.textContent = message;
  notice.classList.toggle("error", isError);
}

async function checkout() {
  const entries = cartEntries();
  if (!entries.length) return;
  const button = $("#checkout-button");
  button.disabled = true;
  button.textContent = "Оформляем…";
  const payload = {
    items: entries.map((item) => ({ productId: item.id, quantity: item.quantity })),
    promoCode: state.promoApplied ? PROMO_CODE : ""
  };

  try {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Не удалось оформить заказ");
    state.cart = {};
    state.promoApplied = false;
    saveStorage(CART_KEY, state.cart);
    $("#promo-input").value = "";
    await loadCatalog();
    showNotice(`Заказ №${result.orderId} сохранён. Сумма: ${formatPrice(result.total)}. Это учебный заказ, оплата не производится.`);
  } catch (error) {
    if (!state.backendAvailable) {
      const { total } = calculateTotals();
      showNotice(`Демо-режим: тестовый заказ на ${formatPrice(total)} сформирован только в браузере. Для сохранения заказа запустите main.py.`);
    } else {
      showNotice(error.message, true);
    }
  } finally {
    button.innerHTML = 'Оформить заказ <span>↗</span>';
    renderCart();
  }
}

categoryList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  state.category = button.dataset.category;
  renderCategories();
  refreshProducts();
});

productGrid.addEventListener("click", (event) => {
  const addButton = event.target.closest("[data-add]");
  const favoriteButton = event.target.closest("[data-favorite]");
  if (addButton) addToCart(addButton.dataset.add);
  if (favoriteButton) toggleFavorite(favoriteButton.dataset.favorite);
});

$("#cart-items").addEventListener("click", (event) => {
  const quantityButton = event.target.closest("[data-quantity]");
  const removeButton = event.target.closest("[data-remove]");
  if (quantityButton) changeQuantity(quantityButton.dataset.quantity, Number(quantityButton.dataset.delta));
  if (removeButton) removeFromCart(removeButton.dataset.remove);
});

$("#search-input").addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  refreshProducts();
});
$("#sort-select").addEventListener("change", (event) => {
  state.sort = event.target.value;
  refreshProducts();
});
$("#favorites-toggle").addEventListener("click", () => {
  state.favoritesOnly = !state.favoritesOnly;
  renderFavoritesCount();
  refreshProducts();
});
$("#reset-filters").addEventListener("click", () => {
  state.category = "all";
  state.query = "";
  state.favoritesOnly = false;
  $("#search-input").value = "";
  renderCategories();
  renderFavoritesCount();
  refreshProducts();
});
$("#apply-promo").addEventListener("click", applyPromo);
$("#promo-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") applyPromo();
});
$("#checkout-button").addEventListener("click", checkout);

loadCatalog();
