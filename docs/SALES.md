# Satış API sözleşmesi

Mevcut `sales`, `sale_items`, `payments` ve `audit_logs` tabloları kullanılır. `0003_sale_item_list_price.sql`, satış anındaki liste fiyatı için nullable bir sütun ekler; yeni tablo/binding yoktur. Satış kaydı teslimatın gerçekleştiği anlamına gelir. Tek işletme modelinde admin/employee tüm şirket satışlarını listeler/okur ve satış oluşturur; başka çalışanın satışına da tahsilat yapılabilir. Oluşturan kişi korunur, serbest düzenleme/silme yetkisi açılmaz. Koşullu iptal ve talepler [CORRECTIONS.md](CORRECTIONS.md) ile uygulanır. Yetkiler API middleware’inde uygulanır; müşteri/ürün yetkileri ve [authentication sözleşmesi](AUTH.md) değişmez. Sonradan tahsilat/borç sözleşmesi: [FINANCE.md](FINANCE.md).

| Metot / yol | İstek | Yanıt |
|---|---|---|
| `POST /api/v1/sales` | JSON + UUID `Idempotency-Key` | İlk kayıt `201 {data:Sale}`; aynı işlem tekrarı `200` |
| `GET /api/v1/sales` | `customer_id`, `from`, `to`, `page`, `pageSize` | `{data:SaleSummary[],pagination:{page,pageSize,total,totalPages}}` |
| `GET /api/v1/sales/:id` | UUID | `200 {data:Sale}` |
| `POST /api/v1/sales/:id/cancel` | UUID; `{reason}` + UUID `Idempotency-Key` | `200 {data:Sale}`; koşullar [CORRECTIONS.md](CORRECTIONS.md) |

## İstek ve doğrulama

POST body alanları:

- `customer_id`: aktif müşterinin UUID’si.
- `items`: 1–50 kalem; her biri `product_id` (aktif ürün UUID’si), `quantity` (pozitif güvenli tam sayı) ve isteğe bağlı `unit_price_kurus` (1–9007199254740991 tam sayı kuruş). Aynı ürün bir kez gönderilir; miktarı artırılır. Birim fiyat gönderilmezse işlem anındaki katalog fiyatı kullanılır. İki rol de onaysız olarak liste fiyatından düşük veya yüksek satış yapabilir; katalog fiyatını değiştirme yetkisi employee'ye açılmaz.
- `payment`: `amount_kurus` (0 veya pozitif güvenli tam sayı), ödeme pozitifse zorunlu `method`: `cash`, `card`, `bank`. Sıfır ödemede yöntem null olarak normalize edilir ve ödeme kaydı eklenmez.

Yalnızca `items[].unit_price_kurus` fiyat alanı yazılabilirdir. Liste fiyatı snapshot'ı, satır ve satış toplamları sunucunun alanlarıdır; istemciden gelen bu ek alanlar ayıklanır ve hesaplamaya katılmaz. API TL ondalığı kabul etmez: web TL metnini en fazla iki ondalıkla BigInt üzerinden tam sayı kuruşa çevirir. Negatif, sıfır, kesirli, string veya güvenli sınırı aşan birim fiyat 400 verir. Yeni satışın gerçekleşen birim fiyatı pozitif olmalıdır; katalog fiyatı sıfırsa pozitif özel fiyat gerekir. **Bu, önceki ücretsiz yeni satış davranışını değiştirir; mevcut sıfır fiyatlı satışlar aynen okunur.** Satır/satış toplamları güvenli tam sayı kuruş sınırında kalmalı, ödeme toplamı aşmamalıdır. Gövde en fazla 16 KiB.

400 biçim/doğrulama, 401 oturum, 403 yetki/origin/CSRF, 404 satış yok, 409 aynı anahtar farklı iş içeriği, 413 boyut, 415 JSON gerekli, 422 geçersiz müşteri/ürün aktifliği veya güncel fiyatla ödeme/sınır uyuşmazlığı, 500 beklenmeyen hata anlamına gelir. Hatalar SQL, stack veya kimlik bilgisi döndürmez. Cookie POST izinli Origin ve oturuma bağlı `X-CSRF-Token` ister. Sales CORS yalnızca mevcut allowlist, GET/POST/OPTIONS ve gerekli başlıkları açar. Yanıtlar `no-store` taşır.

## Atomiklik ve yarış koşulları

Fiyatı önce JavaScript’te okuyup sonra ayrı transaction’da yazma yapılmaz. Parametreli SQL `INSERT ... SELECT`, JSON kalemleriyle ürünleri birleştirir; aktiflik ve güvenli çarpım/toplam kontrollerini aynı transaction’ın içinde yapar. Her satır çarpımdan önce `MAX_SAFE_INTEGER / quantity` ile sınırlandırılır. En fazla 50 satırın ara toplamı SQLite 64-bit tam sayı sınırını aşmaz; satış toplamına ayrıca güvenli JS tam sayı sınırı uygulanır. Para hesabında kayan noktalı işlem/yuvarlama yoktur.

Tek D1 `batch` sırasıyla satış, snapshot kalemleri, varsa ilk ödeme ve audit yazar. Katalog fiyatı `list_unit_price_kurus` alanına, özel fiyat veya katalog fiyatı ise gerçekleşen `unit_price_kurus` alanına kaydedilir; `line_total_kurus` gerçekleşen fiyat × miktardır. Liste fiyatı/ürün adı/aktiflik aynı transaction'dan okunur; satış endpoint'i `products` üzerinde UPDATE yapmaz. Kalem/ödeme/audit yazması hata verirse bütün batch geri alınır. Geçersiz iş koşulunda satış eklenmez; sonraki yazmalar yalnızca o isteğin yeni satış ID’si varsa çalışır, dolayısıyla kısmi kayıt kalmaz. Eşzamanlı katalog değişikliği ya satıştan önce ya sonra etkili olur; başlık toplamı ve snapshot fiyatları karışmaz. Güncel resmî kaynaklar: [D1 atomik batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), [JSON sorguları](https://developers.cloudflare.com/d1/sql-api/query-json/).

## Idempotency ve audit

Mevcut `sales.idempotency_key` UNIQUE kısıtı kullanılır. Saklanan değer, `sale:create:` öneki ve kullanıcı ID’si + istemci UUID’sinin hash’idir; farklı kullanıcılar ayrı işlem kapsamındadır. Audit PK’si aynı işlem kimliğidir. Canonical istek digest'i müşteri, ürün ID'ye göre sıralanan kalem/miktar/**varsa özel birim fiyat** ve normalize ödemeden üretilir. Fiyat alanı gönderilmeyen eski sözleşmenin digest biçimi değişmez; eski işlemler aynı gövde/anahtarla tekrar okunabilir. Aynı anahtarla özel fiyatın değiştirilmesi 409'dur. İlk ödeme anahtarı aynı işleme `initial:` önekiyle bağlanır.

Aynı anahtar/iş içeriği ardışık veya eşzamanlı tekrarlandığında tek satış, kalem seti, ilk ödeme ve audit oluşur. Farklı içerik 409 verir. Ürün sonradan pasif veya farklı fiyatlı olsa da daha önce tamamlanan işlemin tekrarı yeniden satış/fiyatlandırma yapmaz. Yeni anahtar yeni işlem demektir; anahtar/audit geçmişi silinmemelidir. `sale.created` audit’i actor, entity ID, UTC zaman, alan adları ve request digest’i içerir; parola, cookie veya token içermez.

## Yanıtlar ve finansal gerçek

`SaleSummary`: `id`, `customer_id`, `customer_name`, `created_by`, `created_by_username`, `status`, `total_kurus`, `paid_kurus`, `remaining_kurus`, `payment_status`, `created_at`, `updated_at`.

`Sale` bunlara ek olarak `customer:{id,name,phone,address}`, `items` ve `payments` içerir. Kalemler `id`, `product_id`, `product_name_snapshot`, `list_unit_price_kurus` (eski kayıtta null), gerçekleşen `unit_price_kurus`, `quantity`, `line_total_kurus` taşır. Liste fiyatı bilinmeyen eski kayıtta fark/özel fiyat varsayılmaz ve güncel katalogdan doldurulmaz. Ödemeler `id`, `amount_kurus`, `method`, `created_at`, `created_by`, `created_by_username`, `is_initial` taşır. Gizli işlem anahtarları yanıtlanmaz. Müşteri iletişim bilgisi güncel kayıttan gelir; ürün adı/fiyatı yalnızca satış snapshot’ından gelir.

`status` satışın `completed/cancelled` durumudur. `payment_status` ödeme olgusudur: geçerli ödeme toplamı satış toplamına eşitse `paid`, pozitifse `partial`, diğer durumda `credit`. Tamamlanmış satışta kalan = toplam − geçerli ödeme; iptal edilmiş satışta kalan 0’dır. İptal, ödeme yapılmış gibi gösterilmez; UI iptal durumunu ayrıca gösterir. Snapshot toplamı güncel katalogdan yeniden hesaplanmaz. Örnek kontrol: 500 TL satış − 100 TL ilk ödeme = 400 TL kalan borç. Nakit/kart/banka ayrı saklanır; bu modül kasa metriği/raporu oluşturmaz.

Okumalar, kendisi ters kayıt olmayan ve hakkında ters kayıt bulunmayan orijinal ödemeleri geçerli sayar; tanım `finance/sql.ts` üzerinden paylaşılır. Tam ters kayıt, orijinali ikinci kez tahsilat saydırmaz; hareket geçmişi DB’de korunur. Sonradan ödeme [Finans API](FINANCE.md) ile uygulanmıştır ve satış detayı her okumada güncel ödemeleri/borcu gösterir. Hiç ödeme kaydı olmayan satış iptali ve bu iptalin admin onayı [CORRECTIONS.md](CORRECTIONS.md) ile atomiktir; tam hatalı kayıt ters kaydı ve admin teyitli harici iade [FINANCIAL_ADJUSTMENTS.md](FINANCIAL_ADJUSTMENTS.md) ile desteklenir. Ödemeli satış tüm ödemeler bu süreçlerle kapatıldıktan sonra ayrı `sale_cancel` onayıyla iptal edilebilir; kısmi ters kayıt yoktur. `Sale` ayrıca `cancellation_eligibility:{allowed,expires_at,explanation}` ve `cancellation_history` döndürür; geçmiş actor/username, tarih, gerekçe, önce/sonra ve varsa talep/onaylayan admin bilgisini içerir. Oluşturma yanıtında uygunluk bağlamı bulunmayabilir; detay GET güncel kullanıcıya göre uygunluğu yeniden hesaplar, yazma sunucuda tekrar kontrol eder.

Liste varsayılanı sayfa 1/boyut 20, sınırlar 1–100000 / 1–100. `customer_id` UUID; `from` dahil, `to` hariç UTC ISO zamanıdır, `from < to` olmalıdır. Web gün seçimini Europe/Istanbul gün başı/sonraki gün başına çevirir. Sıralama `created_at DESC,id DESC`. Sayım ve liste aynı primary D1 session batch’inde okunur; farklı sayfalar arasında canlı değişikliklere karşı sabit snapshot garantisi yoktur. Detayda başlık/kalem/ödemeler de tek okuma batch’indedir.

## Web ve yeniden deneme

Satış/kalem/ürün/iptal raporları [REPORTS.md](REPORTS.md) ile ayrıca okunur. Geçerli satış toplamı ve adedi satışın kayıt dönemine aittir; iptaller ayrı gösterilir. Ürün raporu güncel katalog yerine satış anındaki ad/fiyat snapshot’ını kullanır; tahsilat toplamı satış toplamıyla eşitlenmez.

`#/satislar` geçmiş, `#/yeni-satis` ve `#/satislar/yeni` yeni satış, `#/satislar/:id` detaydır. Sidebar Satışlar geçmişe gider; Genel Bakış Yeni Satış bağlantısı korunur. Gerçek müşteri/aktif ürün araması ve sayfalı seçim kullanılır. Her kalemde düzenlenebilir TL fiyatı katalogdan başlar; fiyat/miktar değiştiğinde BigInt kuruş önizlemesi anında güncellenir. Liste fiyatından farklı fiyat iki yönde de “Özel fiyat” olarak gösterilir; katalog fiyatı çizilir, tek tıklamayla geri dönülür. Alan yazım sırasında yeniden biçimlendirilmez. Farklı fiyat API'ye `unit_price_kurus` olarak gider; değişmeyen/listeye dönen kalemde alan gönderilmez. Bu durumda kayıt sırasında katalog değişmişse güncel liste fiyatı geçerlidir; ödeme yeni toplamı aşarsa 422 gelir. Başarı ekranı gerçek API verisiyle açılır; detay her açılışta tekrar API’den okunur. Detayda fiyat farkları BigInt ile işaretli gösterilir; liste snapshot'ı bilinmeyen eski kayda “Özel fiyat” varsayımı yapılmaz. Satışı yapan kişi mevcut `created_by_username` alanıdır.

Gönderim kilidi çift tıklamayı engeller. Belirsiz ağ/500/yanıt doğrulama hatasında body ve anahtar korunur, alanlar kilitlenir; aynı işlem tekrar gönderilebilir. Kesin ret durumunda (400/403/413/415/422) düzenleme açılır. Taslak yalnızca kullanıcı kapsamlı tarayıcı belleğindedir; geçici auth kontrolü/sayfa içi gezinmede korunur, başarılı kayıt/çıkış/401’de temizlenir. Refresh gövdeyi kaybettirir; yalnızca opak satış idempotency UUID’si kullanıcı/işlem kapsamlı sessionStorage’da korunur. Aynı bilgiler eski anahtarla tek kayda döner; farklı body 409 verir. Ayrı yeni işlem ancak geçmiş kontrolü açıkça teyit edilip eski anahtar bırakıldıktan sonra başlatılır. Anahtar saklanamazsa istek gönderilmez. Sekme kapatma/depolama temizleme sonrası önce geçmiş kontrol edilmelidir. Kimlik/CSRF tokenı, müşteri/tutar/gövde verisi veya otomatik mutation retry Web Storage’a eklenmedi.

## Özel fiyatlandırmayı devreye alma

`0003_sale_item_list_price.sql` yalnızca nullable liste fiyatı sütunu ekler. `0001/0002` değiştirilmedi; geçmiş kalemler, gerçekleşen fiyatlar ve finansal hareketler güncellenmez/silinmez. Bu geliştirmede hiçbir D1'e migration uygulanmadı. Eksik liste fiyatı sütunu bilinen şema eksikliği olarak `503 DATABASE_SCHEMA_REQUIRED` döner; `/api/health` yalnızca bağlantıyı denetler.

Yetkili operatörün manuel sırası:

1. Yeni sürümü önce ayrı yerel/staging ortamında hazırlayın; mevcut veriyi ve üretim yedeği/geri dönüş planını koruyun. Yerelde bekleyen migration'lar `npm.cmd run db:migrate:local` ile uygulanabilir. Canlıda hedef D1 kimliği ve migration listesi ayrıca doğrulanmalı; 0003 yalnızca yetkili operatör tarafından uygulanmalıdır.
2. Önce 0003 şeması, ardından API, en son web sürümü devreye alınmalıdır. **Yeni web'i eski API ile yayınlamayın:** eski API özel fiyat alanını yok sayar. Yeni API, fiyat göndermeyen mevcut istemcileri destekler.
3. İzole ortamda iki rolle normal/düşük/yüksek fiyat, çok ürün, kuruş hassasiyeti, liste fiyatına dönüş, tam/kısmi/sıfır tahsilat ve sonradan tahsilatı kontrol edin. Katalog fiyatının değişmediğini ve satış/tahsilat/kalan borç/rapor tutarlarının gerçekleşen fiyatı kullandığını karşılaştırın. Üretime deneme/seed işlemi eklemeyin.
4. Sıfır/negatif/kesirli/üst sınırı aşan API fiyatları, miktar/çarpım/toplam taşması, pasif ürün, fazla ödeme, employee katalog PATCH reddi; aynı gövde/anahtarla tek kayıt ve fiyatı değiştirilmiş tekrarın 409 olması kontrol edilmelidir. Eşzamanlı katalog değişikliği/tekrar, hata anında batch rollback ve kayıp yanıt sonrası aynı kilitli fiyat/gövdenin korunması ayrıca değerlendirilmelidir.
5. Eski satışın liste snapshot'ının NULL kaldığını, güncel katalog değişince eski gerçek fiyatın etkilenmediğini, özel fiyatlı satışın iptal/ters kayıt/iade hesabında mevcut gerçekleşen tutarın kullanıldığını doğrulayın. Özel fiyat katalogdan yüksekse fark pozitiftir; “indirim” etiketi kullanılmaz. Yeni ücretsiz satış desteklenmez; eski sıfır fiyatlı kayıtlar korunur.

Kullanıcının talebiyle test dosyaları oluşturulmadı/değiştirilmedi ve otomatik testler çalıştırılmadı. Yalnızca web/API uygulama kodunun `tsc --noEmit` kontrolü ve değişen kaynak dosyalarının ESLint kontrolü yapıldı; ikisi de başarılıdır. Mevcut test harness'leri yalnızca 0001/0002'yi yükleyen açık migration listelerine sahiptir: otomatik testleri daha sonra çalıştırmadan önce ayrı test şemasına 0003'ün dahil edilmesi gerekir. Eski “istemci fiyatı yok sayılır” ve “yeni sıfır fiyatlı satış kabul edilir” beklentileri yeni sözleşmeye göre gözden geçirilmelidir. Aşağıdaki eski test sonuçları bu özellik için test kanıtı değildir. Yeni fiyatlandırma için çalışma zamanı/finansal regresyon/yarış koşulu doğrulaması henüz yapılmadı; build ve deploy çalıştırılmadı.

Özel fiyatlandırmada değişen uygulama dosyaları: API `src/sales/{schemas,repository,endpoints}.ts`, `src/database/errors.ts`, `migrations/0003_sale_item_list_price.sql`; web `src/sales/{SaleForm,SaleRecord}.tsx`, `draft.ts`, `math.ts`, `sales.css`, `src/services/{sales,apiClient}.ts`, `src/utils/format.ts`. Mevcut tahsilat/veresiye/rapor/iptal sorguları `sales.total_kurus`, gerçekleşen `sale_items.unit_price_kurus/line_total_kurus` ve geçerli ödeme toplamlarıyla çalıştığından değiştirilmedi. Authentication, Service Binding ve CSP aynı kaldı.

## Kontroller ve dosyalar

API: `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run build` (dry-run). Bağımsız API lint script’i yoktur; mevcut web ESLint’i ile API kaynak/test Worker’ı kontrol edilir. Web: build içindeki TypeScript, `npm.cmd run lint`, `npm.cmd run test:format`, `npm.cmd run test:sales:math`. Tarayıcı: yeni `test:auth:serve` ortamında `test:sales:browser -- --metadata <browser.json> --playwright-dir <kurulu Playwright üst dizini>`; mevcut Chrome/Playwright kullanılır, kurulum yapılmaz. Ayrıntı: [web README](../../akcat-app/README.md).

Satış modülünün ilk doğrulamasında 66 API testi, 5 fiyat/hesaplama testi ve 39 tarayıcı kontrolü geçti. Ortak görünürlük/tahsilat aşamasında 83 API / 45 tarayıcı kontrolü geçti. İptal/düzeltme aşamasının güncel sonuçları [CORRECTIONS.md](CORRECTIONS.md) içindedir. Fixture’lar yalnızca ayrı test DB kimliği ve geçici persistence içindedir, gerçek iş verisine dokunulmaz. Gerçek edge/üretim kapasitesi test edilmedi; deploy/commit/push yok.

| Alan | Değişen/eklenen dosyalar |
|---|---|
| API | `src/sales/schemas.ts`, `repository.ts`, `endpoints.ts`; `src/index.ts`; `tests/auth.test.mjs`, `tests/worker.ts`; `docs/SALES.md`, `README.md` |
| Web | `src/sales/SalesPage.tsx`, `SaleForm.tsx`, `SaleListPage.tsx`, `SaleRecord.tsx`, `RecordPicker.tsx`, `draft.ts`, `math.ts`, `presentation.ts`, `routing.ts`, `sales.css`; `src/services/sales.ts` |
| Web entegrasyon/test | `src/App.tsx`, `src/layout/navigation.ts`, `src/pages/OverviewPage.tsx`, `src/pages/modulePages.ts`, `src/services/apiClient.ts`; `tests/sales.browser.mjs`, `tests/sales-math.test.mjs`, `tests/run-auth.mjs`; `package.json`, `README.md` |
| Kök | `PROJE.md`, `MIMARI_TASARIM.md` |
