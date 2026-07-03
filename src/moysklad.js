const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// MoySklad tezlik limiti (45 so'rov / 3 soniya) uchun: 429 kelsa server aytgan
// intervalcha kutib, 3 martagacha qayta urinadi.
async function msFetch(url, options, token) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        ...(options.headers || {}),
      },
    });
    if (res.status !== 429) return res;
    const waitMs = parseInt(res.headers.get("x-lognex-retry-timeinterval") || "1000", 10) || 1000;
    await sleep(Math.min(Math.max(waitMs, 500), 5000));
  }
  throw new Error("MoySklad 429: tezlik limiti 3 urinishdan keyin ham o'tmadi");
}

// Uzum buyurtma ID'si MoySklad'da externalCode sifatida saqlanadi
// (uzumOrderToMC shunday yaratadi) — shu orqali buyurtmani topamiz.
// Google Sheets'dagi VLOOKUP ustunining o'rnini bosadi.
async function findByExternalCode(externalCode, token, cfg) {
  const url =
    `${cfg.baseUrl}/entity/customerorder` +
    `?filter=${encodeURIComponent(`externalCode=${externalCode}`)}&limit=1`;
  const res = await msFetch(url, { method: "GET" }, token);
  if (!res.ok) {
    throw new Error(`MoySklad qidiruv ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json();
  return (json.rows && json.rows[0]) || null;
}

async function setOrderState(moyskladOrderId, token, cfg) {
  const url = `${cfg.baseUrl}/entity/customerorder/${moyskladOrderId}`;
  const payload = {
    state: {
      meta: { href: cfg.targetStateHref, type: "state", mediaType: "application/json" },
    },
  };
  const res = await msFetch(url, { method: "PUT", body: JSON.stringify(payload) }, token);
  if (!res.ok) {
    throw new Error(`MoySklad status yangilash ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

module.exports = { findByExternalCode, setOrderState };
