const fs = require("fs");
const path = require("path");

// Google Sheets'dagi "canceled_order" va "cancel_paged" varaqlarining o'rnini
// bosuvchi lokal holat fayli: qaysi buyurtmalar ko'rilgani va MoySklad'da
// yangilangani (orders), har do'konning oxirgi skanerlangan sahifasi
// (shopCursors) hamda Uzum'ga bugun nechta so'rov yuborilgani (uzumRequests).
const dataDir = path.join(__dirname, "..", "data");
const stateFile = path.join(dataDir, "state.json");

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      orders: parsed.orders || {},
      shopCursors: parsed.shopCursors || {},
      uzumRequests: parsed.uzumRequests || {},
    };
  } catch {
    return { orders: {}, shopCursors: {}, uzumRequests: {} };
  }
}

function save(state) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const tmpPath = stateFile + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, stateFile);
}

// Uzum kunlik limiti Toshkent (UTC+5) kuni bo'yicha yangilanadi deb hisoblaymiz.
function todayKey() {
  return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
}

// Har bir kabinet uchun alohida kunlik so'rov hisoblagichi. Har bir haqiqiy
// HTTP so'rov (retry'lar ham) limitdan yechiladi — hisob Uzum tomonidagi
// hisob bilan mos bo'lishi uchun.
function createBudget(state, dailyLimit) {
  const day = todayKey();
  if (!state.uzumRequests[day]) state.uzumRequests[day] = {};
  const counters = state.uzumRequests[day];

  return {
    used(cabinetName) {
      return counters[cabinetName] || 0;
    },
    remaining(cabinetName) {
      return Math.max(0, dailyLimit - this.used(cabinetName));
    },
    trySpend(cabinetName) {
      if (this.used(cabinetName) >= dailyLimit) return false;
      counters[cabinetName] = this.used(cabinetName) + 1;
      return true;
    },
  };
}

function prune(state, pruneDays) {
  const cutoff = Date.now() - pruneDays * 24 * 3600 * 1000;
  for (const [id, order] of Object.entries(state.orders)) {
    if (order.status !== "done" && order.status !== "failed") continue;
    const ts = Date.parse(order.doneAt || order.firstSeenAt || "");
    if (!Number.isNaN(ts) && ts < cutoff) delete state.orders[id];
  }
  // Faqat bugungi hisoblagich kerak — o'tgan kunlarniki o'chiriladi.
  const today = todayKey();
  for (const day of Object.keys(state.uzumRequests)) {
    if (day !== today) delete state.uzumRequests[day];
  }
}

module.exports = { load, save, createBudget, prune, todayKey };
