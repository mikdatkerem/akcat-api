# Satış iptali ve düzeltme talepleri

Dokuz temel tablo, bağımsız Workers/Hono/Chanfana API ve cookie/CSRF/izinli Origin modeli korunur. Finansal düzeltme genişletmesi `0002_financial_adjustments.sql` ek tablo/indekslerini kullanır; paket veya binding değişmez. Güncel tam sözleşme: [FINANCIAL_ADJUSTMENTS.md](FINANCIAL_ADJUSTMENTS.md). Bütün yazmalar JSON, 16 KiB sınırı, UUID `Idempotency-Key`, authentication ve API rol kontrolü ister. D1'e yalnızca API erişir; web/mobil aynı yetki kurallarına tabidir.

## Endpoint sözleşmesi

| Metot / `/api/v1` yolu | İstek / yanıt |
|---|---|
| `POST /sales/:id/cancel` | `{reason}` → `200 {data:Sale}` |
| `POST /correction-requests` | `{target_type,target_id,correction_type,reason,requested_change}` → ilkinde `201 {data:Correction}`, tekrarda `200` |
| `GET /correction-requests` | `status=pending/approved/rejected/all`, `page`, `pageSize` → `{data:Correction[],pagination}` |
| `GET /correction-requests/:id` | `200 {data:Correction}` ve audit geçmişi |
| `POST /correction-requests/:id/approve` | Admin; satış iptali `{reason}`, ödeme düzeltmesi ayrıca beklenen tutar/bakiyeler ve iade teyidi → `200 {data:Correction}` |
| `POST /correction-requests/:id/reject` | Admin; `{reason}` → `200 {data:Correction}` |

Gerekçe/istenen değişiklik trim ve NFC normalizasyonundan sonra 1–1000 karakterdir. Body bilinmeyen alanları reddeder. `target_type` sale/payment; hedef UUID ve mevcut kayıt olmalıdır. Türler: satış için `sale_cancel`, `sale_customer`, `sale_items`, `sale_error`; ödeme için `payment_amount`, `payment_method`, `payment_reversal`, `payment_refund`. Talep türü ile hedef türü eşleşmelidir. İstenen değişiklik açıklama metnidir; SQL veya uygulanacak serbest patch değildir.

`Correction`: istek alanları, `id`, `requested_by`, `requested_by_username`, `status`, `reviewed_by`, `reviewed_by_username`, `reviewed_at`, `created_at`, `can_approve`, `approval_explanation`, `history`, nullable `financial_preview`, `adjustment`, `cancellation_preview`. Önizlemeler ve uygulanmış hareket detay yanıtındadır; listede null’dır. Liste geçmişi boş tutar; detay action/actor/username/UTC tarih ve gerekçe/önce/sonra metadata’sını içerir. Employee yalnızca kendi taleplerini okur; admin hepsini okur ve inceler. Şirket satış/tahsilatlarının ortak görünürlüğü değişmez.

## Kurallar ve uygulanabilen işlemler

Employee yalnızca kendi, sunucu zamanıyla en fazla beş dakikalık, `completed` ve **hiç ödeme kaydı olmayan** satışını doğrudan iptal eder. Admin için sahiplik/süre sınırı yoktur, diğer koşullar aynıdır. Tam ters kayıtla net ödeme sıfırlanmış olsa bile ödeme geçmişi doğrudan iptali engeller. İptal talebi onayı ise bütün asıl ödemeler tipli tam finansal düzeltmeyle kapatılmışsa mümkündür; türü belirsiz eski reversal yeterli değildir. Boş gerekçe kabul edilmez.

`sale_cancel`, hedef satış tamamlanmışsa ve hiç ödeme yoksa veya bütün asıl ödemeler `financial_adjustments` ile tipli ve eş tutarlı/yöntemli karşı kayda bağlanmışsa onaylanır. Admin `payment_reversal` ile gerçekte alınmamış/hatalı kaydı tam tersine çevirir; `payment_refund` ile uygulama dışında fiilen yapılmış tam iadeyi açık teyit/referansla kaydeder. İkisi aktif satış ve müşteri borcunu artırır; satış iptali ayrı bir onaydır. Uygulama para transferi veya banka/POS doğrulaması yapmaz. Orijinal ödeme/kalemler değişmez. Yanlış müşteri/ürün/miktar, diğer satış hatası ve doğrudan tutar/yöntem değişikliği talepleri kaydedilip reddedilebilir, uygulanamaz (`422 CORRECTION_UNSUPPORTED`, pending kalır). Kısmi veya ikinci tam ters kayıt desteklenmez. Ayrıntılar ve beklenen bakiye alanları [finansal düzeltme sözleşmesinde](FINANCIAL_ADJUSTMENTS.md).

Sonuçlandırılmış talebe yeni kararla müdahale `409 CORRECTION_NOT_PENDING`; aynı anahtar ve aynı kararın yeniden iletilmesi mevcut kararı döndürür, ikinci onay/finansal etki oluşturmaz. Doğrudan iptale uygun olmayan durum `409 SALE_CANCELLATION_DENIED`. Biçim 400, oturum 401, rol/CSRF/Origin 403, kayıt yok 404, anahtar-içerik çakışması 409, gövde sınırı 413, JSON 415, beklenmeyen hata 500’dür. Teknik hata/sırlar dışarı verilmez.

## Kayıt modeli, atomiklik ve finansal geçmiş

`correction_requests.proposed_change`, tipli `{correction_type,requested_change}` JSON’unu saklar; ayrı alan/migration gerektirmez. Eski serbest metin talepleri `legacy` olarak görünür ve onaylanamaz. İnceleme kullanıcı/zamanı mevcut `reviewed_by/reviewed_at` alanlarında; karar gerekçesi ve önce/sonra durumu audit’te tutulur.

Her iptal için değişmez `sale.cancelled` audit’i actor, UTC zaman, hedef satış, gerekçe, önceki `completed` ve orijinal borç, sonraki `cancelled/0`, tutar ve varsa talep/ onaylayan admin bağlantısını saklar. Bu kayıt ledger’da ayrı `cancellation` alacak hareketidir. Orijinal satışın borç hareketi ve kalem snapshot’ları değiştirilmez. `status/updated_at` değişir; satış toplamı, müşteri, ürünler ve ödemeler silinmez veya yeniden yazılmaz. Güncel sale `remaining_kurus=0`, receivables/açık satışlar iptal edilen satışı dışlar; tahsilat SQL’i `completed` şartıyla iptal sonrası yazmayı reddeder. İptal ödeme yapılmış gibi gösterilmez: `payment_status` ödeme olgusunu korur, arayüzde ayrıca `İptal edildi` görünür.

İptal öncesindeki tarihsel borç korunur; iptal hareketinin tarihinde sıfırlanır. Önceden dışarıdan iptal edilmiş, `sale.cancelled` audit’i bulunmayan eski kayıtlar için kullanıcı/gerekçe uydurulmaz; eski etkisiz ledger davranışı korunur ve detayda bilgi eksikliği belirtilir. Bu kayıtların gerçek geçmişi ayrıca inceleme/backfill kararı gerektirir.

Koşullu audit INSERT, satış güncellemesi ve onay varsa talep güncellemesi tek [D1 batch transaction](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) içindedir. Karardan önce okunup koşulsuz yazılan bir satış yoktur. Aynı transaction’da satış durumu, bütün ödeme geçmişi, employee sahipliği/süre ve talebin `pending` durumu kontrol edilir. Tahsilat/iptal veya onay/ret yarışında yalnızca uygun ilk işlem ilerler. Herhangi bir audit/yazma hatası tüm batch’i geri alır.

Idempotency audit PK’si kullanıcı + işlem türü + UUID anahtar hash’idir; canonical içerik digest’i farklı içerik için 409 sağlar. Her yeni transaction’ın sunucuya ait attempt UUID’si, önceki başarılı anahtarın durum değişikliklerini yeniden uygulamasını engeller. Audit/idempotency geçmişi silinmemelidir. Parola/cookie/token metadata’ya yazılmaz. İptal metadata’sı finansal geçmişin kaynağıdır; değiştirilmemeli veya temizlenmemelidir.

## Web

`#/duzeltmeler`: admin tüm / employee kendi talepleri, durum filtresi ve sunucu sayfalama. `#/duzeltmeler/yeni?target_type=sale|payment&target_id=...`: gerçek satış detayı veya tahsilat geçmişinden açılan form. `#/duzeltmeler/:id`: durum, gerekçe, istenen değişiklik, inceleyen yönetici ve işlem geçmişi. Admin uygulanabilir iptal veya tam finansal düzeltme için gerekçeli onay, tüm bekleyen talepler için gerekçeli ret yapar. Ödeme düzeltmesinde önce/sonra bakiye, tam tutar, asıl tahsilat; harici iadede zorunlu fiilen gerçekleşme teyidi/referans gösterilir. Satışta ayrı düzeltme geçmişi ve raporlarda ayrı hareket türleri korunur.

Satış detayı sunucudan `cancellation_eligibility:{allowed,expires_at,explanation}` ve `cancellation_history` alır. Bu uygunluk gösterim amaçlıdır; yazmada yeniden doğrulanır. Gerekçeli native dialog klavye odağı/ESC ve arka plan kaydırma kilidiyle iptali onaylatır. Masaüstü sidebar/mobil drawer korunur; alt navigasyon yoktur.

Belirsiz ağ/500/yanıt hatasında özgün body ve anahtar yalnızca kullanıcı kapsamlı bellekte korunur, alanlar kilitlenir. Geçici oturum kontrolü veya sayfa içi gezinme anahtarı kaybettirmez. Kesin ret sonrası alanlar açılır; başarı, logout ve 401 taslağı temizler. Refresh/sekme kapatma belleği siler; sonuç belirsizse yeniden işlemden önce geçmiş kontrol edilmelidir. Düzeltme onayının gövde/anahtarı Web Storage’a yazılmaz; hedef talep/ödeme UNIQUE ve koşullu durum denetimi tekrar finansal etkiyi engeller. Satış/tahsilat oluşturmadaki opak UUID yenileme koruması ayrı uygulanır. Kimlik tokenı, müşteri/tutar verisi, otomatik yazma retry’si veya sahte başarılı yanıt yoktur.

## Kontroller

`tests/corrections.cases.mjs` mevcut auth/müşteri/ürün/satış/finans API testlerine eklenir. Süre/sahiplik/ödeme/ters kayıt, idempotency, borç/ledger, rol, desteklenmeyen onay, iptal/tahsilat ve onay/ret yarışları, bütün yazma türlerinde audit hatası rollback’i, eski talepler ve geçmişin korunması gerçek izole D1 üzerinde doğrulanır.

Tarayıcı: her suite için ayrı `npm.cmd run test:auth:serve` ortamı; `npm.cmd run test:corrections:browser -- --metadata <browser.json> --playwright-dir <kurulu Playwright dizini>`. Test bitince Enter ile geçici ortam temizlenir. Üretim D1 veya gerçek kullanıcı kullanılmaz. TypeScript, kaynak lint ve build kontrolleri; API build yalnızca `--dry-run` kullanır. Gerçek edge/üretim kapasitesi ve para iadesi doğrulanmaz.

Doğrulanan sonuçlar: **104 API testi** (önceki 83 + 21 iptal/düzeltme testi), **5 tutar testi**, **51 tarayıcı kontrolü** (13 auth, 10 müşteri, 9 ürün, 7 satış, 6 finans, 6 iptal/düzeltme). 320/390/1440 px satış, talep formu, onay detayı ve liste kontrollerinde yatay taşma yoktur. İptal dialog’u odak/ESC ve ekran sınırları doğrulandı; tarayıcı JS hatası görülmedi. Web/API TypeScript, kaynak lint ve build başarılıdır; web üretilmiş tip dosyasında önceden bulunan iki lint uyarısı sürer. API’nin ayrı lint script’i olmadığı için mevcut web ESLint’i API kaynakları ve test Worker üzerinde kullanıldı. Geçici test verileri/görseller temizlendi. Deploy/commit/push ve gerçek veri değişikliği yoktur.

## Bu aşamada değişen dosyalar

| Alan | Dosyalar |
|---|---|
| API yeni | `src/corrections/schemas.ts`, `repository.ts`, `endpoints.ts`; `tests/corrections.cases.mjs`; `docs/CORRECTIONS.md` |
| API entegrasyon | `src/index.ts`; `src/sales/repository.ts`, `endpoints.ts`, `schemas.ts`; `src/finance/receivables.ts`, `schemas.ts`; `tests/auth.test.mjs` |
| Web yeni | `src/corrections/CancelSale.tsx`, `CorrectionForm.tsx`, `CorrectionsPage.tsx`, `ReasonForm.tsx`, `operation.ts`, `presentation.ts`, `corrections.css`; `src/services/corrections.ts`; `tests/corrections.browser.mjs` |
| Web entegrasyon | `src/App.tsx`, `src/layout/navigation.ts`; `src/sales/SalesPage.tsx`, `SaleRecord.tsx`; `src/finance/PaymentHistory.tsx`, `CustomerLedger.tsx`; `src/services/sales.ts`, `finance.ts`, `apiClient.ts`; `tests/run-auth.mjs`; `package.json` |
| Dokümanlar | Kök `SKILLS.md`, `PROJE.md`, `MIMARI_TASARIM.md`, `PROMPTLAR.md`; API `README.md`, `docs/SALES.md`, `docs/FINANCE.md`; web `README.md` |

Git çalışma alanlarında önceki modüllerden kalan kayıt edilmemiş değişiklikler vardır; yukarıdaki liste yalnızca bu aşamanın kapsamıdır. Önceki değişiklikler korunmuştur. Bu belgede yukarıdaki eski doğrulama sayıları önceki iptal aşamasına aittir. Sonraki tam ödeme düzeltmesi/iade genişletmesi [FINANCIAL_ADJUSTMENTS.md](FINANCIAL_ADJUSTMENTS.md) ile uygulanmıştır; yeni migration yalnızca izole D1’de test edilmiştir.
