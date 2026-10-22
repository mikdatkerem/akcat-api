# Satış API sözleşmesi

Mevcut `sales`, `sale_items`, `payments` ve `audit_logs` tabloları kullanılır; yeni migration veya binding yoktur. Satış kaydı teslimatın gerçekleştiği anlamına gelir. Tek işletme modelinde admin/employee tüm şirket satışlarını listeler/okur ve satış oluşturur; başka çalışanın satışına da tahsilat yapılabilir. Oluşturan kişi korunur, serbest düzenleme/silme yetkisi açılmaz. Koşullu iptal ve talepler [CORRECTIONS.md](CORRECTIONS.md) ile uygulanır. Yetkiler API middleware’inde uygulanır; müşteri/ürün yetkileri ve [authentication sözleşmesi](AUTH.md) değişmez. Sonradan tahsilat/borç sözleşmesi: [FINANCE.md](FINANCE.md).

| Metot / yol | İstek | Yanıt |
|---|---|---|
| `POST /api/v1/sales` | JSON + UUID `Idempotency-Key` | İlk kayıt `201 {data:Sale}`; aynı işlem tekrarı `200` |
| `GET /api/v1/sales` | `customer_id`, `from`, `to`, `page`, `pageSize` | `{data:SaleSummary[],pagination:{page,pageSize,total,totalPages}}` |
| `GET /api/v1/sales/:id` | UUID | `200 {data:Sale}` |
| `POST /api/v1/sales/:id/cancel` | UUID; `{reason}` + UUID `Idempotency-Key` | `200 {data:Sale}`; koşullar [CORRECTIONS.md](CORRECTIONS.md) |

## İstek ve doğrulama

POST body alanları:

- `customer_id`: aktif müşterinin UUID’si.
- `items`: 1–50 kalem; her biri `product_id` (aktif ürün UUID’si) ve `quantity` (pozitif güvenli tam sayı). Aynı ürün bir kez gönderilir; miktarı artırılır.
- `payment`: `amount_kurus` (0 veya pozitif güvenli tam sayı), ödeme pozitifse zorunlu `method`: `cash`, `card`, `bank`. Sıfır ödemede yöntem null olarak normalize edilir ve ödeme kaydı eklenmez.

Fiyat/toplam alanları sözleşmenin yazılabilir parçası değildir; bilinmeyen istemci alanları Zod tarafından ayıklanır ve fiyatlandırmayı etkilemez. Birim fiyat D1’den okunur. Her kalem, satış toplamı ve ilk ödeme `0..9007199254740991` tam sayı kuruş sınırında kalmalıdır; ödeme toplamı aşamaz. Negatif/kesirli/string tutar, geçersiz/tekrarlı ürün veya miktar reddedilir. Sıfır fiyatlı ürün desteklenir; sıfır toplam/sıfır ödeme, borç kalmadığından `paid` olur. Gövde en fazla 16 KiB.

400 biçim/doğrulama, 401 oturum, 403 yetki/origin/CSRF, 404 satış yok, 409 aynı anahtar farklı iş içeriği, 413 boyut, 415 JSON gerekli, 422 geçersiz müşteri/ürün aktifliği veya güncel fiyatla ödeme/sınır uyuşmazlığı, 500 beklenmeyen hata anlamına gelir. Hatalar SQL, stack veya kimlik bilgisi döndürmez. Cookie POST izinli Origin ve oturuma bağlı `X-CSRF-Token` ister. Sales CORS yalnızca mevcut allowlist, GET/POST/OPTIONS ve gerekli başlıkları açar. Yanıtlar `no-store` taşır.

## Atomiklik ve yarış koşulları

Fiyatı önce JavaScript’te okuyup sonra ayrı transaction’da yazma yapılmaz. Parametreli SQL `INSERT ... SELECT`, JSON kalemleriyle ürünleri birleştirir; aktiflik ve güvenli çarpım/toplam kontrollerini aynı transaction’ın içinde yapar. Her satır çarpımdan önce `MAX_SAFE_INTEGER / quantity` ile sınırlandırılır. En fazla 50 satırın ara toplamı SQLite 64-bit tam sayı sınırını aşmaz; satış toplamına ayrıca güvenli JS tam sayı sınırı uygulanır. Para hesabında kayan noktalı işlem/yuvarlama yoktur.

Tek D1 `batch` sırasıyla satış, snapshot kalemleri, varsa ilk ödeme ve audit yazar. Ürün adı, fiyatı ve aktifliği bu işlem boyunca tutarlı SQLite transaction durumundan okunur. Kalem/ödeme/audit yazması hata verirse bütün batch geri alınır. Geçersiz iş koşulunda satış eklenmez; sonraki yazmalar yalnızca o isteğin yeni satış ID’si varsa çalışır, dolayısıyla kısmi kayıt kalmaz. Eşzamanlı katalog değişikliği ya satıştan önce ya sonra etkili olur; başlık toplamı ve snapshot fiyatları karışmaz. Güncel resmî kaynaklar: [D1 atomik batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), [JSON sorguları](https://developers.cloudflare.com/d1/sql-api/query-json/).

## Idempotency ve audit

Mevcut `sales.idempotency_key` UNIQUE kısıtı kullanılır. Saklanan değer, `sale:create:` öneki ve kullanıcı ID’si + istemci UUID’sinin hash’idir; farklı kullanıcılar ayrı işlem kapsamındadır. Audit PK’si aynı işlem kimliğidir. Canonical istek digest’i müşteri ID, ürün ID’ye göre sıralanan kalem/miktarlar ve normalize ödemeden üretilir; istemci fiyatı digest’e girmez. İlk ödeme anahtarı aynı işleme `initial:` önekiyle bağlanır.

Aynı anahtar/iş içeriği ardışık veya eşzamanlı tekrarlandığında tek satış, kalem seti, ilk ödeme ve audit oluşur. Farklı içerik 409 verir. Ürün sonradan pasif veya farklı fiyatlı olsa da daha önce tamamlanan işlemin tekrarı yeniden satış/fiyatlandırma yapmaz. Yeni anahtar yeni işlem demektir; anahtar/audit geçmişi silinmemelidir. `sale.created` audit’i actor, entity ID, UTC zaman, alan adları ve request digest’i içerir; parola, cookie veya token içermez.

## Yanıtlar ve finansal gerçek

`SaleSummary`: `id`, `customer_id`, `customer_name`, `created_by`, `created_by_username`, `status`, `total_kurus`, `paid_kurus`, `remaining_kurus`, `payment_status`, `created_at`, `updated_at`.

`Sale` bunlara ek olarak `customer:{id,name,phone,address}`, `items` ve `payments` içerir. Kalemler `id`, `product_id`, `product_name_snapshot`, `unit_price_kurus`, `quantity`, `line_total_kurus` taşır. Ödemeler `id`, `amount_kurus`, `method`, `created_at`, `created_by`, `created_by_username`, `is_initial` taşır. Gizli işlem anahtarları yanıtlanmaz. Müşteri iletişim bilgisi güncel kayıttan gelir; ürün adı/fiyatı yalnızca satış snapshot’ından gelir.

`status` satışın `completed/cancelled` durumudur. `payment_status` ödeme olgusudur: geçerli ödeme toplamı satış toplamına eşitse `paid`, pozitifse `partial`, diğer durumda `credit`. Tamamlanmış satışta kalan = toplam − geçerli ödeme; iptal edilmiş satışta kalan 0’dır. İptal, ödeme yapılmış gibi gösterilmez; UI iptal durumunu ayrıca gösterir. Snapshot toplamı güncel katalogdan yeniden hesaplanmaz. Örnek kontrol: 500 TL satış − 100 TL ilk ödeme = 400 TL kalan borç. Nakit/kart/banka ayrı saklanır; bu modül kasa metriği/raporu oluşturmaz.

Okumalar, kendisi ters kayıt olmayan ve hakkında ters kayıt bulunmayan orijinal ödemeleri geçerli sayar; tanım `finance/sql.ts` üzerinden paylaşılır. Tam ters kayıt, orijinali ikinci kez tahsilat saydırmaz; hareket geçmişi DB’de korunur. Sonradan ödeme [Finans API](FINANCE.md) ile uygulanmıştır ve satış detayı her okumada güncel ödemeleri/borcu gösterir. Hiç ödeme kaydı olmayan satış iptali ve bu iptalin admin onayı [CORRECTIONS.md](CORRECTIONS.md) ile atomiktir; tam hatalı kayıt ters kaydı ve admin teyitli harici iade [FINANCIAL_ADJUSTMENTS.md](FINANCIAL_ADJUSTMENTS.md) ile desteklenir. Ödemeli satış tüm ödemeler bu süreçlerle kapatıldıktan sonra ayrı `sale_cancel` onayıyla iptal edilebilir; kısmi ters kayıt yoktur. `Sale` ayrıca `cancellation_eligibility:{allowed,expires_at,explanation}` ve `cancellation_history` döndürür; geçmiş actor/username, tarih, gerekçe, önce/sonra ve varsa talep/onaylayan admin bilgisini içerir. Oluşturma yanıtında uygunluk bağlamı bulunmayabilir; detay GET güncel kullanıcıya göre uygunluğu yeniden hesaplar, yazma sunucuda tekrar kontrol eder.

Liste varsayılanı sayfa 1/boyut 20, sınırlar 1–100000 / 1–100. `customer_id` UUID; `from` dahil, `to` hariç UTC ISO zamanıdır, `from < to` olmalıdır. Web gün seçimini Europe/Istanbul gün başı/sonraki gün başına çevirir. Sıralama `created_at DESC,id DESC`. Sayım ve liste aynı primary D1 session batch’inde okunur; farklı sayfalar arasında canlı değişikliklere karşı sabit snapshot garantisi yoktur. Detayda başlık/kalem/ödemeler de tek okuma batch’indedir.

## Web ve yeniden deneme

Satış/kalem/ürün/iptal raporları [REPORTS.md](REPORTS.md) ile ayrıca okunur. Geçerli satış toplamı ve adedi satışın kayıt dönemine aittir; iptaller ayrı gösterilir. Ürün raporu güncel katalog yerine satış anındaki ad/fiyat snapshot’ını kullanır; tahsilat toplamı satış toplamıyla eşitlenmez.

`#/satislar` geçmiş, `#/yeni-satis` ve `#/satislar/yeni` yeni satış, `#/satislar/:id` detaydır. Sidebar Satışlar geçmişe gider; Genel Bakış Yeni Satış bağlantısı korunur. Gerçek müşteri/aktif ürün araması ve sayfalı seçim kullanılır. Önizleme hesapları BigInt ile kuruş üzerinden yapılır. Kayıt sırasında güncel sunucu fiyatı geçerlidir; toplam değişebilir, fazla ödeme oluşursa 422 gelir. Başarı ekranı gerçek API verisiyle açılır; detay her açılışta tekrar API’den okunur.

Gönderim kilidi çift tıklamayı engeller. Belirsiz ağ/500/yanıt doğrulama hatasında body ve anahtar korunur, alanlar kilitlenir; aynı işlem tekrar gönderilebilir. Kesin ret durumunda (400/403/413/415/422) düzenleme açılır. Taslak yalnızca kullanıcı kapsamlı tarayıcı belleğindedir; geçici auth kontrolü/sayfa içi gezinmede korunur, başarılı kayıt/çıkış/401’de temizlenir. Refresh gövdeyi kaybettirir; yalnızca opak satış idempotency UUID’si kullanıcı/işlem kapsamlı sessionStorage’da korunur. Aynı bilgiler eski anahtarla tek kayda döner; farklı body 409 verir. Ayrı yeni işlem ancak geçmiş kontrolü açıkça teyit edilip eski anahtar bırakıldıktan sonra başlatılır. Anahtar saklanamazsa istek gönderilmez. Sekme kapatma/depolama temizleme sonrası önce geçmiş kontrol edilmelidir. Kimlik/CSRF tokenı, müşteri/tutar/gövde verisi veya otomatik mutation retry Web Storage’a eklenmedi.

## Kontroller ve dosyalar

API: `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run build` (dry-run). Bağımsız API lint script’i yoktur; mevcut web ESLint’i ile API kaynak/test Worker’ı kontrol edilir. Web: build içindeki TypeScript, `npm.cmd run lint`, `npm.cmd run test:format`, `npm.cmd run test:sales:math`. Tarayıcı: yeni `test:auth:serve` ortamında `test:sales:browser -- --metadata <browser.json> --playwright-dir <kurulu Playwright üst dizini>`; mevcut Chrome/Playwright kullanılır, kurulum yapılmaz. Ayrıntı: [web README](../../akcat-app/README.md).

Satış modülünün ilk doğrulamasında 66 API testi, 5 fiyat/hesaplama testi ve 39 tarayıcı kontrolü geçti. Ortak görünürlük/tahsilat aşamasında 83 API / 45 tarayıcı kontrolü geçti. İptal/düzeltme aşamasının güncel sonuçları [CORRECTIONS.md](CORRECTIONS.md) içindedir. Fixture’lar yalnızca ayrı test DB kimliği ve geçici persistence içindedir, gerçek iş verisine dokunulmaz. Gerçek edge/üretim kapasitesi test edilmedi; deploy/commit/push yok.

| Alan | Değişen/eklenen dosyalar |
|---|---|
| API | `src/sales/schemas.ts`, `repository.ts`, `endpoints.ts`; `src/index.ts`; `tests/auth.test.mjs`, `tests/worker.ts`; `docs/SALES.md`, `README.md` |
| Web | `src/sales/SalesPage.tsx`, `SaleForm.tsx`, `SaleListPage.tsx`, `SaleRecord.tsx`, `RecordPicker.tsx`, `draft.ts`, `math.ts`, `presentation.ts`, `routing.ts`, `sales.css`; `src/services/sales.ts` |
| Web entegrasyon/test | `src/App.tsx`, `src/layout/navigation.ts`, `src/pages/OverviewPage.tsx`, `src/pages/modulePages.ts`, `src/services/apiClient.ts`; `tests/sales.browser.mjs`, `tests/sales-math.test.mjs`, `tests/run-auth.mjs`; `package.json`, `README.md` |
| Kök | `PROJE.md`, `MIMARI_TASARIM.md` |
