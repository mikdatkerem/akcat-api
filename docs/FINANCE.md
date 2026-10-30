# Tahsilat, veresiye ve müşteri hareketleri

AKÇAT tek işletmedir. `admin` ve `employee` bütün şirket satışlarını, tahsilatları ve müşteri borçlarını okur; başka çalışanın satışına da tahsilat kaydedebilir. Satış/tahsilatın `created_by` değeri korunur. Bu görünürlük serbest düzenleme/silme veya admin yetkisi vermez. Koşullu satış iptali ve düzeltme incelemesi [CORRECTIONS.md](CORRECTIONS.md) ile sınırlıdır. Authentication, CSRF, tam origin kontrolü ve parametreli SQL kuralları geçerlidir. Gerçek iş verisi veya uzak D1 değiştirilmedi.

## Endpoint’ler

| Metot / yol | İstek | Yanıt |
|---|---|---|
| `POST /api/v1/payments` | JSON + UUID `Idempotency-Key` | İlkinde `201 {data:Payment}`, tekrarda `200` |
| `GET /api/v1/payments` | `q`, `customer_id`, `sale_id`, `method`, `from`, `to`, `status=all/valid`, `min_amount_kurus`, `max_amount_kurus`, `page`, `pageSize` | `{data:Payment[],pagination}` |
| `GET /api/v1/customers/:id/receivables` | UUID müşteri; `page`, `pageSize` | `{customer,summary,data:SaleSummary[],pagination}` |
| `GET /api/v1/customers/:id/ledger` | UUID müşteri; `type=all/sale/payment/reversal/record_reversal/external_refund/cancellation`, `from`, `to`, `page`, `pageSize` | `{customer,summary,data:LedgerEntry[],pagination}` |
| `GET /api/v1/receivables` | `q`, `min_debt_kurus`, `max_debt_kurus`, `page`, `pageSize` | `{data:Debtor[],pagination}` |

Son endpoint, Veresiye ekranının borçlu müşteri arama/sayfalama ihtiyacı içindir. Bütün endpoint’ler oturum ve admin/employee rolü ister. `POST` cookie istemcisinde ayrıca izinli Origin ve oturuma bağlı `X-CSRF-Token`, JSON ve en fazla 16 KiB gövde ister. Geniş CORS izni eklenmedi; yanıtlar `no-store` taşır.

POST yalnızca `customer_id`, `sale_id`, `amount_kurus`, `method` kabul eder; bilinmeyen alanlar reddedilir. Tutar 1–9007199254740991 tam sayı kuruş; yöntem `cash/card/bank`. String, kesirli, sıfır, negatif veya güvenli tam sayı sınırını aşan tutar geçersizdir. Müşteri-satış ilişkisi sunucuda kontrol edilir. Satış `completed` ve yeterli borçlu olmalıdır. Pasif müşterinin mevcut borcu tahsil edilebilir. Müşteri avansı, satışsız ödeme ve otomatik dağıtım yazması yoktur.

400 biçim/filtre, 401 oturum, 403 yetki/origin/CSRF, 404 müşteri yok, 409 aynı anahtar farklı iş içeriği, 413 boyut, 415 JSON, 422 satış-müşteri/durum/kalan borç uyuşmazlığı, 500 beklenmeyen hata anlamına gelir. SQL, stack veya gizli kimlik bilgisi döndürülmez.

## Finansal model

### Liste tutar filtreleri

Tutar sınırları API’de 0–9007199254740991 arası tam sayı **kuruş** olarak alınır; boş/eksik sınır uygulanmaz. Negatif, kesirli, geçersiz, güvenli sınırı aşan veya minimumu maksimumdan büyük aralık `400 INVALID_FINANCE_INPUT` döndürür. Alt/üst sınırlar dahildir; diğer filtrelerle birlikte, sayım ve sayfalama öncesinde parametreli SQL ile uygulanır. UI binlik ayırıcısız TL metnini mevcut BigInt yardımcılarıyla kayıpsız çevirir (`19,99` → `1999`, `1000` → `100000`).

Tahsilatta aralık her `payments` satırının **kendi kayıt tutarına** uygulanır. `q`, gerçek müşteri veya hızlı satıştaki isteğe bağlı isimde arar; isimsiz hızlı satış “Misafir Müşteri” olarak aranabilir. Ters kayıt/iade ve bunlarla kapatılan asıl tahsilatlar `status=all` içinde mevcut `adjustment_kind`, `is_valid`, `reversal_of_payment_id` alanlarıyla ayrı kalır; sıradan geçerli tahsilat sayılmaz. `status=valid` yalnızca mevcut geçerli ödeme kuralını kullanır. Filtrelenmiş liste tutarlarından nakit/net tahsilat toplamı türetilmez.

Veresiye aralığı, müşteri başına açık satışların **güncel kalan borcu toplandıktan sonra** uygulanır; geçmiş satış toplamını filtrelemez. Geçerli tahsilat, iptal ve düzeltme etkileri aynı `balancesCte` ile hesaplanır. Müşterisiz hızlı satışlar borçlu listesine girmez. Sıralama `total_debt_kurus DESC, id` olarak korunur. Yeni borç sütunu veya migration yoktur.

Yerel kurulumda `0001` ve `0002` birlikte gereklidir. `financial_adjustments` yoksa boş geçmiş de sorgu hatasıdır: `503 DATABASE_SCHEMA_REQUIRED`, `data: []` değildir. Tahsilatın yanıt SELECT'i aynı D1 batch'inde olduğundan bu eksiklikte ödeme/audit geri alınır; aynı işlem anahtarı şema düzeltildikten sonra güvenle tekrar kullanılabilir. Doğrulanmış 400/403/413/415/422 retleri arayüzde “Tahsilat kaydedilmedi”; ağ/500/yanıt doğrulama hatası ise belirsiz sonuç olarak gösterilir ve anahtar/gövde korunur. Boş geçmiş tek başına bir yazmanın sonucunu kanıtlamaz. Yerel düzeltme ayrıntıları: [LOCAL_FIXES.md](LOCAL_FIXES.md).

İlk ödeme satış oluşturulurken zaten `payments` içine yazılır; burada yeniden eklenmez. Sonradan tahsilat aynı tabloya eklenir. Satış toplamı kayıtlı snapshot toplamıdır; ürün kataloğundaki güncel fiyat bu hesaplara katılmaz. Geçerli ödeme kendisi ters kayıt olmayan ve hakkında ters kayıt bulunmayan orijinal harekettir. Satışın kalan borcu = kayıtlı toplam − geçerli ödeme toplamı. Müşteri borcu = tamamlanmış satışların kalan borçlarının toplamı. Açık satış sayısı yalnızca pozitif kalan borçlu tamamlanmış satışları sayar; sıfır borçlu müşteri varsayılan borçlu listesinde yoktur. Vade olmadığı için “Gecikmiş” etiketi kullanılmaz.

Kontrol edilen örnek: 500 TL satış − 100 TL ilk ödeme − 250 TL tahsilat = 150 TL kalan; toplam geçerli ödeme 350 TL. Müşterinin başka açık satışları da müşteri toplamına eklenir. Nakit, kart ve banka yöntemleri ayrı saklanır; gelecekte fiziksel kasa hesabı yalnızca geçerli `cash` hareketlerini toplamalıdır. Salt okunur dönem raporları [REPORTS.md](REPORTS.md) içindedir; fiziksel kasa bakiyesi hesaplanmaz.

`finance/sql.ts` geçerli ödeme tanımını satış ve finans sorguları için ortak tutar. Para değerleri SQL INTEGER/TypeScript güvenli tam sayılarıdır; TL formu mevcut BigInt parser/formatter’ı kullanır. Ara toplam, müşteri toplamı veya hareket bakiyesi güvenli tam sayı sınırını aşarsa yuvarlanmış/yanlış tutar yerine hata verilir. SQLite SUM taşması da hata olarak kalır. Büyük finansal hacimler için genişletilmiş tutar sözleşmesi ayrıca tasarlanmalıdır.

## Atomiklik, yarış ve idempotency

Önce borç okuyup sonra koşulsuz yazma yapılmaz. Parametreli `INSERT ... SELECT` aynı yazma transaction’ı içinde satışın müşterisini, `completed` durumunu ve `amount <= total - sum(valid payments)` koşulunu doğrular. Tahsilat + `payment.created` audit’i tek [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) içindedir. SQLite yazmaları sıralandığından ikinci çalışan öncekinin tahsilatını borç kontrolünde görür. 100 TL borca eşzamanlı iki 80 TL isteğinde yalnız biri `201`, diğeri `422` alır; 160 TL oluşmaz. Audit hatasında tahsilat da geri alınır. Kayıt zamanı, satış zamanından önce olamaz.

Mevcut `payments.idempotency_key` UNIQUE alanı kullanılır. Saklanan anahtar `payment:create:` + kullanıcı ID/istemci UUID hash’idir; kullanıcı ve işlem türü kapsamları ayrıdır. Audit PK’si aynı işlemdir; metadata canonical müşteri/satış/tutar/yöntem digest’i ve alan adlarını taşır. Aynı içerik/anahtar eşzamanlı veya ardışık tekrarında tek ödeme/audit oluşur, borç kapanmış olsa bile tekrar aynı kaydı `200` döndürür. Aynı anahtar farklı içerikle `409` verir. Yeni anahtar yeni iş niyetidir; bağımsız işlerin toplamı yine kalan borç koşuluyla sınırlanır. Parola/cookie/token audit’e kopyalanmaz. Audit/idempotency kayıtları silinmemelidir.

## Yanıtlar ve filtreler

`Payment`: `id`, `customer_id`, `customer_name`, `sale_id`, `amount_kurus`, `method`, `created_by`, `created_by_username`, `created_at`, `is_initial`, `is_valid`, `reversal_of_payment_id`, `sale_remaining_kurus`. Son alan, yanıt okunduğu andaki satış borcudur; geçmiş ödeme sonrasının sabit snapshot’ı değildir. İşlem anahtarları yanıtlanmaz. Eski şemadaki satışsız hareketler tahsilat geçmişinde null satışla okunabilir; yeni POST bunları oluşturamaz, satış borcuna dağıtmaz.

`summary`: `total_debt_kurus`, `open_sales_count`, `last_payment_at`. `customer`: `id`, `name`, `phone`. `Debtor` bu ikisinin alanlarını birleştirir. Müşteri receivables `data` yalnızca açık satışları, mevcut [satış özet sözleşmesiyle](SALES.md) döndürür; summary bütün müşteriyi kapsar, sayfaya bağlı değildir.

`LedgerEntry`: `id` (tür önekli), `type` (`sale`, `payment`, `reversal`, `record_reversal`, `external_refund`, `cancellation`), `sale_id`, `amount_kurus`, `method`, `created_at`, `created_by`, `created_by_username`, `effective`, `balance_after_kurus` (işlem sonrası müşteri borcu), `sale_balance_after_kurus` (işlem sonrası ilgili satış borcu). Satışa bağlı orijinal ödemeler ve mevcut ters kayıtlar dahil bütün hareketler korunur. Satış borç, ödeme alacak, tam ters kayıt yeniden borç etkisi taşır. Yeni iptallerde asıl satışın tarihsel borcu korunur; `sale.cancelled` audit’inden üretilen ayrı `cancellation` hareketi iptal tarihinde borcu kapatır. Güncel receivables iptal edilen satışları dışlar. Audit’i bulunmayan eski iptaller için önceki etkisiz ledger davranışı korunur; geçmiş uydurulmaz. Tam hatalı kayıt ters kaydı ve admin teyitli harici iade ayrı tipli hareketlerdir; aktif satış borcunu yeniden açarlar. Ödemeli iptal önceki ödeme/karşı kayıtların tarihsel etkisini korur. Kısmi ters kayıt yoktur; [finansal düzeltme sözleşmesi](FINANCIAL_ADJUSTMENTS.md); ayrıntı [CORRECTIONS.md](CORRECTIONS.md).

Hareket bakiyeleri tüm satışa bağlı müşteri geçmişi üzerinde window SUM ile hesaplanır; tür/tarih filtresi ve sayfalama bundan sonra uygulanır. Aynı zamandaki sıralama satış → ödeme → ters kayıt → iptal → ID ile belirlenir. Liste en yeni hareketten başlar. Tarihler UTC ISO; `from` dahil, `to` hariç, `from < to`. Web gün sınırlarını Europe/Istanbul ile çevirir. Sayfa varsayılanı 1, boyut 20; sınırlar 1–100000 ve 1–100. Borçlu araması Türkçe büyük/küçük harfi destekleyen literal ad alt dizisidir; `%`, `_` veya SQL metni operatör olmaz. Borçlular borç azalan/ID; açık satışlar tarih/ID artan; ödemeler tarih/ID azalan sıralanır. Her yanıtın sayım/satır/özet okumaları aynı primary session batch’inde tutarlıdır; farklı sayfalar arasında canlı veri snapshot garantisi yoktur.

## Web ve sınırlar

Gerçek dashboard, Nakit Tahsilat/kart/banka, satış/ürün, güncel borç ve admin çalışan raporları [REPORTS.md](REPORTS.md) ile uygulanmıştır. Satış ve tahsilat kendi kayıt tarihlerine, açık borç tüm tarihlerdeki açık satışlara bağlıdır. Nakit Tahsilat fiziksel kasa bakiyesi değildir; açılış/çıkış/sayım/kapanış bulunmuyor. Raporlar mevcut borç ve geçerli ödeme sorgularını paylaşır, finansal kayıtlara yazmaz.

`#/tahsilatlar` geçmiş/filtreler, `#/tahsilatlar/yeni?customer_id=...&sale_id=...` seçili borca tahsilat, `#/veresiye` borçlu listesi. Müşteri detayında açık borç, açık satışlar ve hareket sonrası bakiyeler; satış detayında mevcut güncel ödemeler/bakiye ve tahsilat bağlantısı gösterilir. Başarılı POST’tan sonra borç API’den tekrar alınır. Sonraki okuma hata verirse kayıt başarı bilgisi ile borcun okunamadığı hata ayrı gösterilir; tahsilat yeniden oluşturulmaz.

Belirsiz ağ/500/yanıt doğrulama hatasında özgün body/anahtar korunur, alanlar kilitlenir; aynı tahsilat tekrar gönderilir. Kesin ret durumunda düzenleme açılır. Kullanıcı kapsamlı bellek taslağı geçici auth kontrolü ve uygulama içi gezinmede korunur; başarılı kayıt/çıkış/401’de temizlenir. Refresh gövdeyi kaybettirir; opak tahsilat idempotency UUID’si kullanıcı/işlem kapsamlı sessionStorage’da korunur. Aynı bilgilerle tekrar tek kaydı döndürür; farklı bilgiler 409 verir. Ayrı yeni işlemden önce kullanıcı geçmişi kontrol ettiğini teyit eder. Anahtar saklanamazsa istek gönderilmez. Sekme kapatma/depolama temizleme sonrası belirsiz işlem geçmişten uzlaştırılır. Kimlik tokenı veya müşteri/tutar/gövde verisi Web Storage’a yazılmaz; otomatik retry, mock başarı veya demo iş verisi yoktur.

Temel tahsilat için migration/paket/binding/auth değişmedi; sonraki finansal düzeltme genişletmesi `0002_financial_adjustments.sql` ek tablosunu kullanır. Yerel şema düzeltmesi ve doğrulama [LOCAL_FIXES.md](LOCAL_FIXES.md) içindedir; uzak migration uygulanmadı. Koşullu ödemesiz satış iptali ve admin kararları [CORRECTIONS.md](CORRECTIONS.md) ile uygulanır. Fiziksel silme, serbest finansal düzenleme, kısmi ters kayıt/iade, genel avans, otomatik dağıtım ve kasa kapanışı yoktur. Üretim edge/kapasite doğrulaması yapılmadı; yerel başarı üretim yük testi değildir. Tam düzeltme/iade uygulaması [FINANCIAL_ADJUSTMENTS.md](FINANCIAL_ADJUSTMENTS.md) ile tanımlıdır; sistem harici para hareketini gerçekleştirmez veya doğrulamaz.

## Kontroller ve değişen dosyalar

API: `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run build` (dry-run). API’nin bağımsız lint script’i yoktur; mevcut web ESLint’iyle kaynaklar ve test Worker kontrol edildi. Web: build/TypeScript, lint, `test:format`, `test:sales:math`; tarayıcı `test:finance:browser` ve mevcut auth/müşteri/ürün/satış suite’leri. Kurulu Chrome/Playwright kullanılır; [web README](../../akcat-app/README.md) komutları izlenir. Her suite ayrı geçici D1 kimliği/persistence kullanır. Gerçek veriye test yazılmaz; sonunda Enter ile ortam temizlenir.

Tahsilat aşamasında doğrulanan sonuçlar: önceki 66 test + 17 finans testi = 83 API; 5 tutar ve 45 tarayıcı kontrolü. İptal/düzeltme aşamasının güncel sonuçları [CORRECTIONS.md](CORRECTIONS.md) içindedir. Testler yalnızca izole geçici D1 kullanır; deploy/commit/push yapılmaz.

| Alan | Değişen/eklenen dosyalar |
|---|---|
| API finans | `src/finance/sql.ts`, `schemas.ts`, `payments.ts`, `receivables.ts`, `endpoints.ts` |
| API entegrasyon/test | `src/index.ts`, `src/sales/repository.ts`, `src/sales/endpoints.ts`; `tests/auth.test.mjs`, `tests/finance.cases.mjs`, `tests/worker.ts` |
| Web finans | `src/finance/PaymentsPage.tsx`, `PaymentForm.tsx`, `PaymentHistory.tsx`, `ReceivablesPage.tsx`, `CustomerAccount.tsx`, `CustomerLedger.tsx`, `Pagination.tsx`, `draft.ts`, `routing.ts`, `finance.css`; `src/services/finance.ts` |
| Web entegrasyon/test | `src/App.tsx`, `src/layout/navigation.ts`, `src/customers/CustomerRecordPage.tsx`, `src/sales/SaleListPage.tsx`, `src/sales/SaleRecord.tsx`, `src/services/sales.ts`, `src/services/apiClient.ts`; `tests/finance.browser.mjs`, `tests/run-auth.mjs`; `package.json` |
| Temizlenen iskelet | Artık kullanılmayan `src/pages/ModulePage.tsx` ve `modulePages.ts` |
| Dokümanlar | Kök `SKILLS.md`, `PROJE.md`, `MIMARI_TASARIM.md`, `PROMPTLAR.md`; API `README.md`, `docs/FINANCE.md`, `docs/SALES.md`, `docs/CUSTOMERS.md`; web `README.md` |

## Hızlı satış (30.10.2026)

Müşterisiz `walk_in` satış, NULL müşteri ilişkileri ve aynı atomik işlemde tam ödeme/iptal istisnası [WALK_IN_SALES.md](WALK_IN_SALES.md) ile tanımlıdır. Normal satış kuralları korunur; hızlı satışın tam ters kaydı/iadesi ayrı açık borç bırakmadan aynı batch’te satışını iptal eder. Eski müşterisiz kaydı normal müşteri olarak varsaymayın; liste/raporlarda NULL ilişkiyi koruyun.
