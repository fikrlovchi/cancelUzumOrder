const logger = require("./logger");

const TIMEOUT_MS = 3000;
// Panel bitta run uchun ko'pi bilan 500 ta log qabul qiladi — ortiqchasi
// yuborilsa butun hisobot 400 bilan rad etiladi, shuning uchun oxirgilarini olamiz.
const MAX_LOGS = 500;

// Fire-and-forget: panel vaqtincha ishlamasa ham, bu buyurtma sinxronizatsiyasi
// natijasiga (process.exitCode) ta'sir qilmasligi kerak — shuning uchun barcha
// xatolar shu yerda yutiladi.
async function reportRun({ startedAt, status, successCount, errorCount, summary }) {
  const url = process.env.PANEL_INGEST_URL;
  const apiKey = process.env.PANEL_API_KEY;
  const slug = process.env.PANEL_PROJECT_SLUG;
  const logs = logger.getBufferAndClear().slice(-MAX_LOGS);

  if (!url || !apiKey || !slug) return; // panel integratsiyasi sozlanmagan — jim o'tkazib yuboriladi

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
        "X-Project-Slug": slug,
      },
      body: JSON.stringify({
        startedAt,
        finishedAt: new Date().toISOString(),
        status,
        successCount,
        errorCount,
        summary,
        logs,
      }),
      signal: controller.signal,
    });
  } catch {
    // panelga yetkazib bo'lmadi — asosiy jarayon uchun ahamiyatsiz
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { reportRun };
