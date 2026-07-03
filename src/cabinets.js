const logger = require("./logger");

// .env'dan Uzum kabinetlari va do'konlarini yig'adi:
//   UZUM_TOKEN_<KABINET>=token
//   UZUM_SHOP_<KABINET>_<BELGI>=shopId   (yoki suffiksiz: UZUM_SHOP_<KABINET>)
// Kabinet nomida pastki chiziq bo'lishi mumkin, shuning uchun do'kon kaliti
// eng uzun mos kabinet nomiga bog'lanadi.
function parseCabinets(env) {
  const cabinets = {};
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^UZUM_TOKEN_(.+)$/);
    if (match && value && value.trim()) {
      cabinets[match[1]] = { name: match[1], token: value.trim(), shopIds: [] };
    }
  }

  const names = Object.keys(cabinets).sort((a, b) => b.length - a.length);
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("UZUM_SHOP_") || !value || !value.trim()) continue;
    const rest = key.slice("UZUM_SHOP_".length);
    const cabinetName = names.find((n) => rest === n || rest.startsWith(n + "_"));
    if (!cabinetName) {
      logger.error(`${key} hech qaysi UZUM_TOKEN_* kabinetiga mos kelmadi — e'tiborsiz qoldirildi`);
      continue;
    }
    const shopId = value.trim();
    if (!cabinets[cabinetName].shopIds.includes(shopId)) {
      cabinets[cabinetName].shopIds.push(shopId);
    }
  }

  const list = [];
  for (const cabinet of Object.values(cabinets)) {
    if (cabinet.shopIds.length === 0) {
      logger.error(`"${cabinet.name}" kabinetida birorta ham do'kon (UZUM_SHOP_${cabinet.name}_*) yo'q — o'tkazib yuborildi`);
      continue;
    }
    list.push(cabinet);
  }

  if (list.length === 0) {
    throw new Error(".env'da birorta ham to'liq Uzum kabineti (UZUM_TOKEN_* + UZUM_SHOP_*) topilmadi");
  }
  return list;
}

module.exports = { parseCabinets };
