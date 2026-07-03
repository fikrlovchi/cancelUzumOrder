# cancelUzumOrder

Uzum'dagi **CANCELED** (FBS) buyurtmalarni topib, MoySklad'dagi mos buyurtmani
"bekor qilingan" statusga o'tkazadi. Ilgari ikkita Google Apps Script
(`FetchCanceledOrdersOptimized` + `cancelMCOrder`) va Google Sheets orqali ishlagan
jarayonning Google'siz, bitta servisga jamlangan varianti. `fikrlovchi.uz`
paneliga run hisobotlarini yuboradi va panel orqali boshqariladi.

> PENDING_DELIVERY oqimi alohida servis (`packingUzumOrder`) sifatida yuritiladi —
> bu papka faqat CANCELED uchun.

## Qanday ishlaydi

Har ishga tushishda (systemd timer, standart har 10 daqiqada):

1. **Uzum sweep** — har bir do'kon uchun
   `GET /v2/fbs/orders?shopIds=<shop>&status=CANCELED&scheme=FBS&page=<kursor>&size=50`
   saqlangan **sahifa kursoridan** boshlab o'qiladi (`data/state.json` →
   `shopCursors`).
2. Yangi ko'rilgan buyurtma ID'lari `orders` ga `pending` bo'lib yoziladi
   (Google Sheets'dagi `canceled_order` varag'ining o'rnini bosadi).
3. **MoySklad yangilash** — har bir `pending` buyurtma MoySklad'da
   `filter=externalCode=<uzum_id>` orqali topiladi (`uzumOrderToMC` buyurtmani
   shu kod bilan yaratadi) va statusi `config.json` dagi `targetStateHref`
   (bekor qilingan holat) ga o'tkaziladi. Muvaffaqiyatdan keyin `done` deb
   belgilanadi va boshqa tegilmaydi.
   - MoySklad'da hali topilmasa — keyingi run'da yana uriniladi
     (`maxAttemptsPerOrder` martagacha, keyin `failed`).
   - Allaqachon kerakli statusda bo'lsa — PUT yuborilmaydi (so'rov tejaladi).

## Sahifa kursori — CANCELED uchun asosiy optimizatsiya

CANCELED buyurtmalar tarixiy tarzda **to'planib boradi**. Har run'da 0-sahifadan
qayta skanerlash minglab eski sahifani o'qib, kunlik limitni bir zumda tugatardi.
Shuning uchun har do'kon uchun oxirgi skanerlangan sahifa raqami saqlanadi
(eski GAS'dagi `cancel_paged` varag'ining o'rnini bosadi):

- **To'la sahifalar** (50 ta buyurtma) "muhrlangan" — ularga yangi buyurtma
  qo'shilmaydi, qayta o'qilmaydi, kursor oldinga suriladi.
- **To'la bo'lmagan birinchi sahifa** — "chegara": yangi bekor qilingan
  buyurtmalar aynan shu yerda paydo bo'ladi. Kursor shu yerda qoladi va keyingi
  run uni qayta tekshirib, yangilarini oladi.
- Natijada steady-state'da run boshiga do'kon uchun atigi **1-2 so'rov**:
  muhrlangan sahifalar qayta skanerlanmaydi, chegara sahifasi hech qачон
  o'tkazib yuborilmaydi.

**Dastlabki backfill:** birinchi run(lar)da barcha tarixiy CANCELED sahifalar
o'qiladi. Bir run'da do'kon boshiga ko'pi bilan `maxPagesPerSweep` (standart 40)
sahifa; qolgani kursor orqali keyingi run'ga o'tadi. Kunlik limit tugasa —
ertaga davom etadi. Backfill tugagach sarf o'z-o'zidan minimal darajaga tushadi.

> **Taxminni tekshiring:** kursor Uzum ro'yxatni barqaror, "eski buyurtma oldinda"
> tartibida qaytaradi deb hisoblaydi (yangilari oxiriga qo'shiladi) — eski GAS
> kod ham shunga tayangan. Agar API yangilarni oldinga qo'ysa, `shopCursors` ni
> tozalab (yoki kod'da har run 0-sahifadan o'qishga o'tib) qayta ko'rish kerak.

## Uzum kunlik limiti

- Har bir kabinet uchun alohida hisoblagich `data/state.json` da Toshkent kuni
  bo'yicha saqlanadi; har bir haqiqiy HTTP so'rov (retry'lar ham) hisobdan yechiladi.
- `UZUM_DAILY_REQUEST_LIMIT` ga yetilganda Uzum sweep to'xtaydi, run panelda
  `partial` bo'lib ko'rinadi, kursor esa progressni saqlaydi. MoySklad bosqichi
  bunga qaramay ishlayveradi (u Uzum limitiga tegmaydi).

## Sozlash (.env)

```
PANEL_INGEST_URL=http://127.0.0.1:3000/api/ingest/runs
PANEL_PROJECT_SLUG=cancel-uzum-order
PANEL_API_KEY=            # seed-project chiqargan kalit
MOYSKLAD_TOKEN=           # panel O'zgaruvchilar sahifasidan bog'lanadi
UZUM_DAILY_REQUEST_LIMIT=500

# Kabinet va do'konlar (istalgancha):
UZUM_TOKEN_MAIN=<kabinet tokeni>
UZUM_SHOP_MAIN_1=<shop id>
UZUM_SHOP_MAIN_2=<shop id>
UZUM_TOKEN_IKKINCHI=<boshqa kabinet tokeni>
UZUM_SHOP_IKKINCHI_1=<shop id>
```

Panel "Muhit sozlamalari" bog'lamalari: `UZUM_TOKEN_*` → *Uzum kabinet*,
`UZUM_SHOP_*` → *Uzum do'kon*, `MOYSKLAD_TOKEN` → *Token*.

MoySklad'dagi bekor qilingan status `config.json` → `moysklad.targetStateHref`
da turadi (`...states/a47989ee-97e3-11ed-0a80-0ca1009761c9`); boshqa statusga
o'tkazish kerak bo'lsa shu href o'zgartiriladi.

## Mahalliy ishga tushirish

```powershell
npm install
cp .env.example .env   # qiymatlarni to'ldiring
npm start
```

Loglar `logs/YYYY-MM-DD.log` ga, holat `data/state.json` ga yoziladi.

## Serverga yuklash (panel bilan bir xil droplet)

```bash
git clone https://github.com/fikrlovchi/cancelUzumOrder.git /root/cancelUzumOrder
cd /root/cancelUzumOrder
npm ci --omit=dev
cp .env.example .env    # qiymatlarni to'ldiring

cp deploy/cancel-uzum-order.service /etc/systemd/system/
cp deploy/cancel-uzum-order.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now cancel-uzum-order.timer
```

## Panelga ulash

1. Panel serverida: `node scripts/seed-project.js cancel-uzum-order "Uzum CANCELED -> MoySklad"`
   — chiqqan API kalitni `.env` dagi `PANEL_API_KEY` ga qo'ying.
2. Panel kodida `src/config/manageable-units.js` ga `cancel-uzum-order` yozuvi
   allaqachon qo'shilgan (interval/pause/run-now/muhit boshqaruvi uchun) —
   panelni qayta deploy qiling.
3. Panelning loyiha sahifasida "Muhit sozlamalari" orqali tokenlar va
   do'konlarni yuqoridagi kalitlarga bog'lang.
