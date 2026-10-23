# Kasa / tahsilat ve finansal raporlar

Raporlar salt okunurdur. Mevcut Workers + Hono + Chanfana, D1, authentication/Origin/CORS kuralları korunur. Bütün endpoint’ler oturum, aktif kullanıcı ve rol ister; yanıtlar `no-store` taşır. Rapor modülü binding/bağımlılık veya özet/cache katmanı eklemez. Finansal düzeltme genişletmesi `0002` ek tablosunu okur; [FINANCIAL_ADJUSTMENTS.md](FINANCIAL_ADJUSTMENTS.md) geçerlidir.

Yerel hata düzeltmesi: `0002` eksikliği boş veritabanında da ödeme/özet raporunu engeller; API `503 DATABASE_SCHEMA_REQUIRED` döndürür. Başarılı sıfır sonuç gerçek boş durumdur. Dashboard başlığı ve açıklaması bugün (`Europe/Istanbul`) içindeki en yeni 10 hareketin gösterildiğini, eski günlerin rapor filtresinde bulunacağını açıkça belirtir. Güncel yerel şema ve kontrol kaydı: [LOCAL_FIXES.md](LOCAL_FIXES.md).

## API sözleşmesi

| `GET /api/v1/reports/…` | Kapsam / yanıt |
|---|---|
| `summary` | `{range,sales,payments,receivables,recent}`; işletme özeti ve seçili dönemin en yeni en fazla 10 hareketi |
| `sales` | `{range,summary,view,data,pagination}`; satışlar, ayrı iptaller, kalemler veya tarihsel ürün toplamları |
| `payments` | `{range,summary,data:Payment[],pagination}`; yalnızca geçerli tahsilatlar, ilk ödemeler dahil |
| `receivables` | `{range,balance_scope:"current",summary,data,pagination}`; tüm tarihlerdeki güncel açık borçlar |
| `employees` | `{range,data,pagination}`; **yalnızca admin**, satış oluşturan / tahsilatı kaydeden ayrı hesaplanır |

Diğer dört endpoint admin/employee ortak operasyon görünürlüğünü korur. Employee yönetim raporuna doğrudan URL/API çağrısında 403 alır; bu kontrol doğrulamadan önce uygulanır. Rapor okumaları yazma veya düzeltme yetkisi vermez. Genel audit listeleme, kasa çıkışı veya kasa kapanışı yoktur. Tam ters kayıt ve admin teyitli harici iadeler ayrı hareket/toplam olarak izlenir.

### Filtreler ve tarihler

- `period`: `today` (varsayılan), `yesterday`, `last7` (bugün dahil son 7 yerel gün), `month` (ayın başından bugün sonuna), `custom`.
- `custom` yalnızca `from=YYYY-MM-DD&to=YYYY-MM-DD` ile kullanılır; iki gün de dahildir. Diğer dönemlerde bu alanların verilmesi reddedilir. Geçerli takvim günleri ve başlangıç ≤ bitiş zorunludur; desteklenen özel günler 1900–9998 aralığındadır.
- API, saatini ve IANA `Europe/Istanbul` saat dilimini kullanarak gün başlangıçlarını UTC’ye dönüştürür. SQL `created_at >= range.from AND created_at < range.to` uygular. UTC bitiş bir sonraki yerel gün başıdır; tarayıcıdan gelen UTC toplamları/zamanı güvenilir kaynak sayılmaz. Tarihsel UTC+02 dönemi de desteklenir.
- `range`: `period`, `start_date`, `end_date` (dahil yerel günler), `from`, `to` (hariç UTC bitiş), `time_zone`, `generated_at`.
- Liste endpoint’leri `page=1..100000`, `pageSize=1..100` (varsayılan 1/20) ve en fazla 100 karakter `q` alır. Sayım ve satırlar aynı okuma batch’indedir. Canlı değişiklikler farklı sayfalar arasında sabit snapshot garantisi vermez.
- `q` satış/kalem/tahsilat/borçta müşteri adı, ürün görünümünde satış anındaki ürün adı, çalışan raporunda kullanıcı adında literal Türkçe aramadır. SQL veya `%`/`_` operatör değildir. Arama yalnızca listeyi filtreler; üst toplamlar seçili dönem ve varsa çalışanın tamamını kapsar. Borç üst toplamı tüm müşterilerindir. UI bu kapsamı açıkça gösterir.
- `sales` için `view=sales/cancelled/items/products` (varsayılan `sales`). **Yalnızca admin**, `sales` ve `payments` raporlarını UUID `created_by` ile gerçek işlem kullanıcısına filtreleyebilir; çalışan raporundaki bağlantılar bu filtreyi kullanır. Employee bu yönetim ayrıntısı parametresiyle doğrudan istekte 403 alır; ortak operasyon kayıtlarını çalışan filtresi olmadan görmeye devam eder.
- `summary` yalnızca dönem filtresi kullanır; arama, çalışan, farklı görünüm veya sayfalama talebi reddedilir. `payments`/`receivables`/`employees` farklı satış görünümlerini, son ikisi çalışan filtresini kabul etmez.
- Borç raporu tarih aralığına göre tarihsel bakiye üretmez. `balance_scope=current` ve rapor zamanı döner; UI tarih filtresi yerine güncel kapsamı belirtir. Verilen geçerli dönem, güncel borcu sınırlandırmaz. Vade sistemi olmadığından gecikmiş borç hesabı yoktur.

Hatalar: 400 geçersiz filtre/dönem/tarih/sayfa, 401 oturum yok, 403 rol veya Origin, 500 veri/hesaplama hatası. SQL, stack veya sır döndürülmez. Hata yanıtı sahte sıfır/boş başarıya çevrilmez.

## Finansal hesaplama

- **Satış:** kayıtlı `sales.created_at` dönemi ve güncel `status='completed'`; `sales_total_kurus`, `sales_count`. İptaller `cancelled_total_kurus/cancelled_count` olarak aynı oluşturulma dönemi için ayrı gösterilir. Sonradan iptal edilen eski satış geçmiş dönem raporundan da çıkar; kapanmış tarihsel muhasebe snapshot’ı üretilmez.
- **Tahsilat:** kayıtlı `payments.created_at` dönemi ve ortak `finance/sql.ts` geçerli ödeme tanımı. Satış tarihiyle sınırlandırılmaz; eski satışın bugünkü tahsilatı yalnızca bugünkü tahsilata girer. İlk ödeme mevcut `payments` kaydından bir kez sayılır. `payments_total_kurus`, `payments_count`, `cash_kurus`, `card_kurus`, `bank_kurus` döner.
- **Nakit Tahsilat** fiziksel kasa bakiyesi değildir. Açılış, çıkış, sayım ve kapanış bulunmadığından çekmecedeki para hesaplanmaz. Nakit/kart/banka tutarları birbirinden ayrıdır.
- **Güncel borç:** ortak `balancesCte` ve mevcut veresiye modelinden türetilir; tamamlanmış, pozitif kalanlı satışlar. İptal ve kapanmış satışlar dışlanır. `total_debt_kurus`, `debtor_count`, `open_sales_count`, açık satışların `sales_total_kurus` ve `paid_kurus` alanları döner. Müşteri satırında bu toplamlar ve ad/telefon/son geçerli tahsilat bulunur. Satış − ödeme = borç eşitliği yalnızca bu açık satış kapsamındadır.
- **Ürün:** `sale_items` içindeki ad, birim fiyat, miktar ve kalem tutarı snapshot’ı kullanılır. Katalog fiyat/adı okunarak geçmiş yeniden hesaplanmaz. Aynı ürünün farklı tarihsel adı/fiyatı ayrı satırdır; grup `product_id,product_name_snapshot,unit_price_kurus`, tutar `sum(line_total_kurus)` olur. Kalem görünümü satışa/müşteriye/çalışana ve tarihe bağlanır.
- **Çalışan:** satışlar `sales.created_by`, tahsilatlar `payments.created_by` altında ayrı aggregate edilir ve daha sonra birleştirilir. Kalem × ödeme join çoğalması oluşmaz. Admin dahil seçili dönemde işlemi olan kullanıcılar, sonradan pasif/rolü değişmiş olsa da tarihsel actor olarak görünür. Satış adedi/toplamı, iptal adedi/toplamı, tahsilat adedi/toplamı ve yöntem tutarları döner.
- **Son işlemler:** dönem içindeki satış, geçerli ödeme ve gerçek `sale.cancelled` audit hareketi ayrı türlerle gösterilir. Asıl iptal edilmiş satışın durumu görünür; iptal audit’i ayrı olaydır. Her satır müşteri, tutar, actor ve UTC kayıt zamanını içerir. Satış ve ilk ödeme ayrı olaylar olup toplamlarda birleştirilmez.

Bekleyen/reddedilen veya desteklenmeyen düzeltmeler finansal olarak uygulanmış sayılmaz. Mevcut tam ters kayıtlar ortak geçerli ödeme tanımı gereği tahsilattan dışlanır; yazmalar admin talep onayındaki ayrı finansal düzeltme akışındadır. Geçmiş dönem tahsilatları güncel geçerliliğe göre okunur; tarihsel iade/mahsuba ilişkin muhasebe raporu değildir. Bütün tutarlar INTEGER kuruştur; SUM/quantity veya JSON sayıları güvenli tam sayı sınırını aşarsa yuvarlama yerine hata döner. Web para gösterimi BigInt destekli mevcut `formatMoney` kullanır.

## Performans ve tutarlılık

Her raporun toplam/sayım/satır sorguları tek `withSession('first-primary').batch(...)` okumasında yürür. Parametreli tarih aralıkları tarih sütununu fonksiyon içine almaz. Mevcut `idx_sales_date`, `idx_payments_date`, `idx_audit_logs_date`; kalem/satış/ödeme/müşteri ve reversal UNIQUE indeksleri kullanılır. İzole `EXPLAIN QUERY PLAN` testleri satış ve ödeme tarih sorgularının mevcut indeksleri kullandığını doğrular. Bu ölçek için gereksiz migration eklenmedi.

Yaklaşık ayda 2.000 satışta SQL aggregate + sınırlı sayfa yaklaşımı kullanılır; bütün dataset istemciye çekilmez. Güncel borç, doğası gereği geçmiş açık satışları/geçerli ödemeleri tarar. Özet tablo, cache veya istemcide tüm veriyle toplam çıkarma yoktur. 45 ek satırlık fixture ile 47 sonuç üzerinde üç sayfanın sınırları ve tekilliği doğrulandı; üretim edge/yük/uzun yıllar veri hacmi benchmark’ı yapılmadı. Veri büyüdüğünde gerçek sorgu planı/süreleri ölçülerek bileşik indeks ihtiyacı değerlendirilmelidir.

## Ekranlar ve platform navigasyonu

Genel Bakış gerçek bugünkü satış/tahsilat/nakit/adet ve tüm tarihlerdeki açık borcu, dönem/rapor zamanını ve son işlemleri gösterir. Sıfır yalnızca başarılı API yanıtından gelir; hata/yüklenme ayrı gösterilir. Mevcut `/api/health` kontrolü korunur.

`#/raporlar` ve `#/raporlar/tahsilatlar`: Tahsilat Raporu; `#/raporlar/satislar`: geçerli/iptal/kalem/ürün görünümleri; `#/raporlar/borclar`: güncel borç; `#/raporlar/calisanlar`: admin yönetim raporu. Filtreler ve sayfa hash query’sinde korunur. Çalışanın doğrudan yönetim adresi arayüzde engellenir; API ayrıca 403 uygular.

`akcat-app`: masaüstünde sabit sol sidebar, mobil tarayıcıda üst header/hamburger/soldan drawer; hiçbir web genişliğinde bottom navigation yoktur. Raporlar gerçek sayfalara bağlı ikincil menüdedir. Gelecekteki native `akcat-mobile` bottom navigation ve platforma özgü yerleşim kullanacak; aynı tokenlar/API paylaşılır, navigasyon mekanizması paylaşılmak zorunda değildir. Native uygulama bu aşamada geliştirilmedi.

## Kontroller ve dosyalar

API `npm.cmd test`: mevcut 104 regresyon + yeni 17 rapor testi, ayrı geçici D1 ortamlarıyla çalışır. `tests/report-environment.mjs` mevcut test Worker/config/migration’ını kullanır, rastgele fixture hesaplarını yalnızca geçici persistence içinde oluşturur ve sonunda temizler. Gerçek D1/migration/hesap kullanılmaz. API typecheck, build (`--dry-run`), mevcut web ESLint’iyle API kaynak ve test Worker kontrol edilir; bağımsız API lint script’i yoktur.

Web: build/TypeScript, lint, `test:format`, `test:sales:math`; yeni geçici `test:auth:serve` ortamında `test:reports:browser -- --metadata <browser.json> --playwright-dir <kurulu Playwright dizini>`. Gerçek React/proxy/API ile boş ve dolu özet, tarih filtreleri, snapshot fiyat, admin yetkisi, hata/yeniden deneme, actor drilldown ve 320/390/1440 px kontrolleri yapılır. Mevcut tarayıcı suite’leri ayrı temiz ortamlarda çalıştırılmalıdır; bitince Enter ile temizlenir.

Doğrulanan sonuçlar: **121 API testi** (104 regresyon + 17 rapor), **5 tutar testi**, **57 tarayıcı kontrolü** (13 auth, 10 müşteri, 9 ürün, 7 satış, 6 finans, 6 iptal/düzeltme, 6 rapor). Employee yönetim raporuna ve `created_by` ayrıntılarına erişemez; admin gerçek tahsil eden kullanıcıya filtrelenebilir. Web/API TypeScript, build ve kaynak lint başarılıdır. API build yalnızca dry-run’dır; web’in üretilmiş tip dosyasında önceden bulunan iki lint uyarısı sürer. 320/390/1440 px dashboard ve raporlarda yatay taşma/tarayıcı JS hatası görülmedi. Bütün test fixture’ları ve geçici görseller temizlendi. Üretim yük/edge testi, deploy, commit/push veya gerçek veri değişikliği yapılmadı.

| Alan | Bu aşamada değişen/eklenen dosyalar |
|---|---|
| API rapor | `src/reports/schemas.ts`, `range.ts`, `repository.ts`, `endpoints.ts`; `src/index.ts` |
| API ortak/test | `src/finance/receivables.ts`; `tests/report-environment.mjs`, `tests/reports.test.mjs`; `package.json` |
| Web rapor | `src/reports/DashboardReport.tsx`, `ReportParts.tsx`, `ReportFilters.tsx`, `ReportViews.tsx`, `ReportsPage.tsx`, `routing.ts`, `reports.css`; `src/services/reports.ts` |
| Web entegrasyon/test | `src/App.tsx`, `src/pages/OverviewPage.tsx`, `src/layout/navigation.ts`, `NavigationLinks.tsx`, `layout.css`; `src/services/apiClient.ts`, `finance.ts`; `tests/reports.browser.mjs`, `tests/run-auth.mjs`; `package.json` |
| Dokümanlar | `docs/REPORTS.md`, API/web README, `docs/SALES.md`, `docs/FINANCE.md`, kök `SKILLS.md`, `PROJE.md`, `MIMARI_TASARIM.md`, `PROMPTLAR.md`, `AKCAT_DESIGN_SYSTEM.md` |

## Finansal düzeltme genişletmesi

Genel Bakış ve Tahsilat Raporu `adjustments` alanı ters kayıt ve teyitli harici iadeleri ayrı toplam/adet ve nakit/kart/banka kırılımlarında sunar. Hareket listesi `GET /api/v1/financial-adjustments` üzerinden aynı UTC aralık ve varsa admin çalışan filtresiyle sayfalanır. Son işlemlerde `record_reversal`/`external_refund` ayrı türlerdir. Çalışan raporundaki düzeltme tutarları uygulayan admine aittir; yalnızca düzeltme yapan kullanıcı da görünür.

Geçerli tahsilat asıl tahsilat tarihinde güncel geçerliliğiyle hesaplanır; sonradan iade geçmiş dönemdeki geçerli tahsilatı azaltabilir. Düzeltme/iade kendi admin kayıt tarihinde gösterilir; bu iki ölçü toplanıp/çıkarılıp dönemsel net nakit akışı üretilmez. İade geçerli tahsilattan ikinci kez düşülmez. Güncel borç ve iptal edilen satışlar ortak finansal kuralları kullanır. Ayrıntı, migration ve sınırlar: [FINANCIAL_ADJUSTMENTS.md](FINANCIAL_ADJUSTMENTS.md).
