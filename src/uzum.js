const logger = require("./logger");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Kunlik so'rov limiti tugaganini bildiradi — sweep to'xtaydi, lekin oldin
// topilgan buyurtmalar MoySklad'da baribir yangilanadi.
class BudgetExhaustedError extends Error {
  constructor(cabinetName) {
    super(`"${cabinetName}" kabineti uchun Uzum kunlik so'rov limiti tugadi`);
  }
}

function buildUrl(shopId, page, cfg) {
  return (
    `${cfg.baseUrl}/v2/fbs/orders?shopIds=${shopId}` +
    `&status=${cfg.status}&scheme=${cfg.scheme}&page=${page}&size=${cfg.pageSize}`
  );
}

// Bitta sahifani oladi. Har bir haqiqiy HTTP urinish oldidan spend() chaqiriladi,
// shunda retry'lar ham kunlik limitdan yechiladi.
async function requestPage(url, token, maxRetry, spend, cabinetName) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    if (!spend()) throw new BudgetExhaustedError(cabinetName);

    let res;
    try {
      res = await fetch(url, { headers: { Authorization: token } });
    } catch (e) {
      lastErr = e; // tarmoq xatosi — kutib qayta urinamiz
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }

    if (res.status === 200) return res.json();

    lastErr = new Error(`Uzum API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    lastErr.httpStatus = res.status;
    // 4xx (429'dan tashqari) — token yoki parametr xato, qayta urinish foydasiz
    if (res.status >= 400 && res.status < 500 && res.status !== 429) throw lastErr;

    const retryAfterSec = parseInt(res.headers.get("retry-after") || "0", 10) || 0;
    await sleep(Math.max(retryAfterSec * 1000, 1000 * 2 ** (attempt - 1)));
  }
  throw lastErr;
}

// CANCELED buyurtmalar tarixiy tarzda to'planib boradi, shuning uchun har bir
// do'kon uchun oxirgi skanerlangan sahifa raqami (kursor) saqlanadi va keyingi
// run o'sha yerdan davom etadi (eski GAS'dagi "cancel_paged" varag'i o'rnini bosadi).
//
// Kursor mantig'i: to'la sahifalar ("pageSize" ta buyurtma) "muhrlangan" — ularga
// yangi buyurtma qo'shilmaydi, shuning uchun ularni qayta o'qimaymiz va kursorni
// oldinga suramiz. To'la bo'lmagan (partial yoki bo'sh) birinchi sahifa — "chegara":
// yangi bekor qilingan buyurtmalar aynan shu yerda paydo bo'ladi. Kursor shu
// chegara sahifasida qoldiriladi, shunda keyingi run uni qayta tekshiradi va
// yangilarini oladi. Bu — bir run'da bor-yo'g'i 1-2 so'rov (oltin o'rtalik):
// muhrlangan sahifalar qayta skanerlanmaydi, chegara sahifasi esa hech qачон
// o'tkazib yuborilmaydi.
//
// DIQQAT: bu Uzum ro'yxatni barqaror, "eski buyurtma oldinda" tartibida
// qaytaradi degan taxminga asoslanadi (yangilari oxiriga qo'shiladi). Eski GAS
// kod ham shunga tayangan. Agar API yangilarni oldinga qo'ysa, kursor o'rniga
// har run'da 0-sahifadan o'qish kerak bo'ladi.
async function sweepShop(cabinet, shopId, startPage, budget, cfg, ids) {
  const spend = () => budget.trySpend(cabinet.name);
  let page = Math.max(0, parseInt(startPage, 10) || 0);

  for (let fetched = 0; fetched < cfg.maxPagesPerSweep; fetched++) {
    let json;
    try {
      json = await requestPage(buildUrl(shopId, page, cfg), cabinet.token, cfg.maxRetry, spend, cabinet.name);
    } catch (e) {
      if (e instanceof BudgetExhaustedError) {
        // Bu sahifani tugatolmadik — kursor shu yerda qoladi, keyingi run davom etadi.
        return { cursor: page, exhausted: true, capped: false };
      }
      throw e;
    }

    const orders = (json && json.payload && json.payload.orders) || [];
    for (const order of orders) ids.add(String(order.id));

    if (orders.length < cfg.pageSize) {
      // Chegara sahifasi — kursor shu yerda qoladi (keyingi run qayta tekshiradi).
      return { cursor: page, exhausted: false, capped: false };
    }

    page++; // to'la sahifa muhrlandi, keyingisiga o'tamiz
  }

  // maxPagesPerSweep chegarasiga yetdik (odatda faqat dastlabki backfill paytida):
  // kursor keyingi o'qilmagan sahifada, keyingi run davom etadi.
  return { cursor: page, exhausted: false, capped: true };
}

// Kabinetning har bir do'konini o'z kursoridan skanerlaydi. Budjet tugasa
// qolgan do'konlar keyingi run'ga qoldiriladi. Faqat muvaffaqiyatli skanerlangan
// do'konlarning kursori qaytariladi (xato bergan do'kon kursori o'zgarmaydi).
async function sweepCabinet(cabinet, cursors, budget, cfg) {
  const ids = new Set();
  const newCursors = {};
  let exhausted = false;

  for (const shopId of cabinet.shopIds) {
    const startPage = cursors[shopId] || 0;
    try {
      const { cursor, exhausted: ex, capped } = await sweepShop(
        cabinet, shopId, startPage, budget, cfg, ids
      );
      newCursors[shopId] = cursor;
      if (capped) {
        logger.info(
          `"${cabinet.name}" do'kon ${shopId}: bir run chegarasi (${cfg.maxPagesPerSweep} sahifa) — ` +
            `qolgani keyingi run'da (kursor ${cursor})`
        );
      }
      if (ex) {
        exhausted = true;
        break;
      }
    } catch (e) {
      logger.error(`"${cabinet.name}" do'kon ${shopId} skanerlashda xato: ${e.message}`);
    }
  }

  return { ids, exhausted, newCursors };
}

module.exports = { sweepCabinet, BudgetExhaustedError };
