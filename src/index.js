require("dotenv").config();

const config = require("../config.json");
const logger = require("./logger");
const reporter = require("./reporter");
const stateStore = require("./state");
const { parseCabinets } = require("./cabinets");
const uzum = require("./uzum");
const moysklad = require("./moysklad");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Eski ikki GAS skriptning birlashmasi (CANCELED oqimi):
//  1-bosqich (FetchCanceledOrdersOptimized o'rnida): Uzum'dan CANCELED buyurtma
//    ID'larini har do'konning saqlangan sahifa kursoridan yig'ib, yangi
//    ko'rilganlarini state'ga "pending" qilib qo'shadi.
//  2-bosqich (cancelMCOrder o'rnida): har bir pending buyurtmani MoySklad'da
//    externalCode orqali topib, statusini config'dagi targetStateHref'ga (bekor
//    qilingan holat) o'tkazadi.
async function run() {
  const startedAt = new Date().toISOString();

  const msToken = process.env.MOYSKLAD_TOKEN;
  if (!msToken) throw new Error("MOYSKLAD_TOKEN .env faylida topilmadi");
  const dailyLimit = parseInt(process.env.UZUM_DAILY_REQUEST_LIMIT || "500", 10);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1) {
    throw new Error("UZUM_DAILY_REQUEST_LIMIT musbat butun son bo'lishi kerak");
  }

  const cabinets = parseCabinets(process.env);
  const state = stateStore.load();
  const budget = stateStore.createBudget(state, dailyLimit);

  const stats = {
    newOrders: 0,
    updated: 0,
    alreadyDone: 0,
    waitingMoySklad: 0,
    givenUp: 0,
    sweepErrors: 0,
    msErrors: 0,
    budgetExhausted: false,
    timeBudgetExceeded: false,
  };

  // ===== 1-BOSQICH: Uzum'dan buyurtma ID'larini yig'ish =====
  for (const cabinet of cabinets) {
    try {
      const { ids, exhausted, newCursors } = await uzum.sweepCabinet(
        cabinet, state.shopCursors, budget, config.uzum
      );
      // Faqat skanerlangan do'konlarning kursorini yangilaymiz.
      Object.assign(state.shopCursors, newCursors);
      if (exhausted) {
        stats.budgetExhausted = true;
        logger.error(
          `"${cabinet.name}": kunlik limit (${dailyLimit}) tugadi — ` +
            `qolgan sahifalar keyingi run/kunda olinadi. Intervalni kattalashtirishni o'ylab ko'ring.`
        );
      }
      for (const id of ids) {
        if (!state.orders[id]) {
          state.orders[id] = { status: "pending", attempts: 0, firstSeenAt: new Date().toISOString() };
          stats.newOrders++;
        }
      }
      logger.info(
        `"${cabinet.name}": ${ids.size} ta CANCELED buyurtma ko'rildi, ` +
          `bugungi Uzum so'rovlari: ${budget.used(cabinet.name)}/${dailyLimit}`
      );
    } catch (e) {
      stats.sweepErrors++;
      logger.error(`"${cabinet.name}" kabinetini o'qishda xato: ${e.message}`);
    }
  }

  // ===== 2-BOSQICH: pending buyurtmalarni MoySklad'da yangilash =====
  // Sweep xato bergan yoki limit tugagan bo'lsa ham, oldingi run'larda topilgan
  // buyurtmalar bu bosqichda baribir qayta ishlanadi (Uzum so'rovi sarflanmaydi).
  const pending = Object.entries(state.orders).filter(([, o]) => o.status === "pending");
  const runDeadline = Date.now() + config.run.maxDurationMs;
  let processedSinceSave = 0;

  for (const [orderId, order] of pending) {
    if (Date.now() > runDeadline) {
      stats.timeBudgetExceeded = true;
      logger.info(
        `Vaqt byudjeti (${config.run.maxDurationMs}ms) tugadi — qolgan buyurtmalar keyingi run'da davom etadi.`
      );
      break;
    }

    try {
      const msOrder = await moysklad.findByExternalCode(orderId, msToken, config.moysklad);

      if (!msOrder) {
        // MoySklad'dagi buyurtma odatda uzumOrderToMC tomonidan bir necha
        // daqiqada yaratiladi — topilmasa keyingi run'da yana urinamiz.
        order.attempts++;
        if (order.attempts >= config.moysklad.maxAttemptsPerOrder) {
          order.status = "failed";
          order.doneAt = new Date().toISOString();
          stats.givenUp++;
          logger.error(
            `Buyurtma ${orderId}: MoySklad'da ${order.attempts} urinishda ham topilmadi — kuzatuvdan chiqarildi`
          );
        } else {
          stats.waitingMoySklad++;
          if (order.attempts === 1 || order.attempts % 10 === 0) {
            logger.info(`Buyurtma ${orderId}: MoySklad'da hali topilmadi (urinish ${order.attempts})`);
          }
        }
      } else if (msOrder.state && msOrder.state.meta && msOrder.state.meta.href === config.moysklad.targetStateHref) {
        // Allaqachon kerakli statusda — PUT so'rovini tejaymiz.
        order.status = "done";
        order.doneAt = new Date().toISOString();
        order.moyskladId = msOrder.id;
        stats.alreadyDone++;
      } else {
        await moysklad.setOrderState(msOrder.id, msToken, config.moysklad);
        order.status = "done";
        order.doneAt = new Date().toISOString();
        order.moyskladId = msOrder.id;
        stats.updated++;
        logger.info(`Buyurtma ${orderId}: MoySklad'da bekor qilindi (${msOrder.id})`);
      }
    } catch (e) {
      stats.msErrors++;
      logger.error(`Buyurtma ${orderId}: ${e.message}`);
    }

    // Uzoq run o'rtada uzilib qolsa ham (server restart, timeout) progress
    // yo'qolmasligi uchun oraliq saqlash.
    processedSinceSave++;
    if (processedSinceSave >= config.run.saveStateEvery) {
      stateStore.save(state);
      processedSinceSave = 0;
    }

    await sleep(config.moysklad.requestDelayMs);
  }

  stateStore.prune(state, config.state.pruneDays);
  stateStore.save(state);

  return { startedAt, stats };
}

function deriveStatus(stats) {
  const errorCount = stats.sweepErrors + stats.msErrors + stats.givenUp;
  const successCount = stats.updated + stats.alreadyDone;
  if (errorCount > 0 && successCount === 0) return "error";
  if (errorCount > 0 || stats.budgetExhausted || stats.timeBudgetExceeded) return "partial";
  return "success";
}

function buildSummary(stats) {
  const parts = [
    `${stats.newOrders} yangi`,
    `${stats.updated} bekor qilindi`,
    `${stats.alreadyDone} allaqachon joyida`,
    `${stats.waitingMoySklad} MoySklad'ni kutmoqda`,
    `${stats.sweepErrors + stats.msErrors + stats.givenUp} xato`,
  ];
  if (stats.budgetExhausted) parts.push("Uzum kunlik limiti tugadi");
  if (stats.timeBudgetExceeded) parts.push("vaqt byudjeti tugadi, qolgani keyingi run'da");
  return parts.join(", ");
}

run()
  .then(async ({ startedAt, stats }) => {
    logger.info("Ish yakunlandi: " + buildSummary(stats));
    await reporter.reportRun({
      startedAt,
      status: deriveStatus(stats),
      successCount: stats.updated + stats.alreadyDone,
      errorCount: stats.sweepErrors + stats.msErrors + stats.givenUp,
      summary: buildSummary(stats),
    });
  })
  .catch(async (e) => {
    logger.error(`Umumiy xato: ${e.stack || e.message}`);
    process.exitCode = 1;
    await reporter.reportRun({
      startedAt: new Date().toISOString(),
      status: "error",
      successCount: 0,
      errorCount: 1,
      summary: e.message,
    });
  });
