# Güvenli finansal düzeltme ve harici iade

## İşlem modeli

Yalnızca **tam tutar ve asıl tahsilatla aynı ödeme yöntemi** desteklenir. Adminin iade teyidi hem fiilen gerçekleşmeyi hem aynı yöntemle tam iadeyi kapsar; farklı yöntemle iade bu sürümde kaydedilemez. Orijinal satış, kalem snapshot’ları ve tahsilat değiştirilmez veya silinmez. Her işlem orijinale bağlı, aynı tutar/yöntem/müşteri/satış bilgisini taşıyan **pozitif** bir `payments.reversal_of_payment_id` satırı ve tipli bir `financial_adjustments` kaydı oluşturur:

| Talep türü | Hareket türü | Anlamı |
|---|---|---|
| `payment_reversal` | `record_reversal` | Gerçekte alınmamış/hatalı kaydedilmiş tahsilatın muhasebesel geri alınması. Müşteriye para gönderilmez. |
| `payment_refund` | `external_refund` | Uygulama dışında fiilen tamamlanmış tam para iadesinin admin tarafından teyit edilerek kaydedilmesi. |

Uygulama POS/banka entegrasyonu, para transferi veya harici işlem doğrulaması yapmaz. `external_confirmed_at`, admin teyidinin sunucu zamanıdır; bankanın işlem tarihi değildir. Teyit sorumluluğu onaylayan admindedir. Referans belge/harici işlem numarasıdır; uygulama belgeyi doğrulamaz. Aynı yöntem/referans ikinci kez kullanılamaz; tek referansla birden fazla tahsilatı topluca iade etme desteklenmez.

Geçerli ödeme tanımı değişmez: kendisi ters kayıt olmayan ve hakkında ters kayıt bulunmayan asıl ödeme. Ters kayıt/iade bu ödemeyi geçersizleştirir, **aktif satışın kalan borcunu ve müşterinin toplam borcunu tam tutar kadar artırır**. Satışı iptal etmez. Tahsilat zaten geçerli toplamdan çıkarıldığı için iade tutarı ikinci kez çıkarılmaz. Negatif ödeme veya ikinci/üçüncü ters kayıt oluşturulmaz.

`financial_adjustments`: asıl ödeme, karşı kayıt, satış, müşteri, talep bağlantıları; tür, kuruş tutarı, yöntem, gerekçe; `requested_by`, `performed_by`, `approved_by`; işlem anındaki önce/sonra satış ve müşteri borcu; harici referans/teyit ve UTC kayıt zamanı. Uygulayan ve onaylayan bu sürümde aynı admindir, ayrı alanlarda izlenir; dört göz zorunluluğu yoktur. Orijinal tahsilatı yapan kişi asıl kayıtta korunur. UNIQUE ödeme/talep/karşı kayıt alanları aynı finansal etkinin tekrarını engeller.

## Yetkiler ve endpoint sözleşmesi

Mevcut authentication, cookie, CSRF, exact Origin, body sınırı ve UUID `Idempotency-Key` korunur. Employee talep oluşturur, kendi talep detayını okur; bütün finansal onay/ret işlemleri API’de admin gerektirir. Operasyonel satış/tahsilat/hareket geçmişi iki role ortaktır; çalışan bazlı yönetim filtresi `created_by` yalnızca admin’e açıktır.

Yeni yazma endpoint’i yoktur; mevcut akış genişletilir:

1. `POST /api/v1/correction-requests`: `{target_type:"payment",target_id,correction_type:"payment_reversal"|"payment_refund",reason,requested_change}`. Açıklamalar trim/NFC sonrası 1–1000 karakter; serbest uygulanacak patch değildir.
2. `GET /api/v1/correction-requests/:id`: mevcut alanlara ek `financial_preview`, `adjustment`, `cancellation_preview`. Liste bunları null döndürür. Pending uygulanabilir ödeme talebinin önizlemesi asıl ödeme/tarih/kullanıcı/müşteri/tutar/yöntem, önce/sonra satış ve müşteri borcu, `requires_external_confirmation` içerir. Uygulanmış harekette `adjustment` kalıcı işlem anı snapshot’ıdır; güncel borç değildir. Satış iptal talebinde ayrı iptal önizlemesi bulunur.
3. `POST /api/v1/correction-requests/:id/approve`: ödeme düzeltmesi için aşağıdaki body. Ret ve satış iptali onayı mevcut `{reason}` sözleşmesini korur.

```json
{
  "reason": "İnceleme gerekçesi",
  "expected_amount_kurus": 1999,
  "expected_sale_remaining_kurus": 0,
  "expected_customer_debt_kurus": 0,
  "refund_confirmation": { "confirmed": true, "reference": "harici-belge-numarasi" }
}
```

Bu sözleşme örneğidir, uygulama/test verisi değildir. `expected_*` alanları güncel API önizlemesinden alınır; serbest düzeltme tutarı değildir. `refund_confirmation` yalnızca `payment_refund` için zorunludur; `payment_reversal` için gönderilmez. Kısmi tutar, yanlış talep türü, eksik teyit, eski bakiye, ikinci ters kayıt veya kullanılan referansla işlem uygulanmaz. Eksik önizleme 400 `FINANCIAL_PREVIEW_REQUIRED`; güvenli koşullar sağlanmıyorsa 409 `FINANCIAL_ADJUSTMENT_DENIED`; anahtar/içerik çakışması 409 `IDEMPOTENCY_CONFLICT`. Desteklenmeyen diğer talep türleri 422 `CORRECTION_UNSUPPORTED`; talep pending kalır. Hatalar iş verisi/sır sızdırmaz.

4. Yeni salt okunur `GET /api/v1/financial-adjustments`: `page`/`pageSize` (1–100000 / 1–100, varsayılan 1/20), `customer_id`, `sale_id`, `kind`, `from` dahil/`to` hariç UTC, admin için `created_by` (uygulayan kullanıcı). `{data:Adjustment[],pagination}`; en yeni tarih/ID. DELETE/PATCH/POST yoktur. Ödeme liste yanıtında `adjustment_kind` ve `adjustment_id` asıl ve karşı kaydı ilişkilendirir.

## Ödemeli satış iptali

Doğrudan `/sales/:id/cancel` kuralı korunur: **hiç ödeme geçmişi olmamalıdır**; employee yalnızca kendi ilk beş dakikalık satışını, admin süre/sahiplik sınırı olmadan iptal eder.

Ödemeli satış için admin önce her asıl tahsilatı ayrı talepte inceler. Gerçekten alınan para uygulama dışında fiilen iade edilip teyit edilir; gerçekte alınmamış hatalı kayıt ayrı ters kayıt türüyle kapatılır. Bütün asıl ödemeler tipli, eş tutarlı/yöntemli ve doğru ilişkili karşı kayıtlarla kapatılmadan `sale_cancel` talebi uygulanamaz. Türü belirsiz eski reversal satırı yeterli değildir. Ardından ayrı `sale_cancel` admin onayı satış borcunu kaldırır, `sale.cancelled` audit/ledger hareketini oluşturur. Yeni tahsilat gelirse iptal koşulları yeniden değerlendirilir; iptal edilen satışa tahsilat yapılamaz. Orijinal satış, ödemeler, düzeltmeler ve iptal geçmişi birlikte görünür.

Ledger orijinal satış (+), tahsilat (−), `record_reversal`/`external_refund` (+), iptal (−satış toplamı) sırasını korur. Yeni iptal önceki ödeme hareketlerini etkisizleştirmez. Audit’siz eski iptallere geçmiş uydurulmaz. Satışa bağlı olmayan eski ödeme, kısmi düzeltme, iadenin geri alınması, tutar/yöntem/customer/items patch’i, otomatik yeni doğru tahsilat veya toplu iade desteklenmez; gerekirse doğru tahsilat mevcut API’den ayrı işlem olarak kaydedilir.

## Atomiklik ve tekrar güvenliği

Koşullu karar audit’i → pozitif karşı ödeme → tipli adjustment → finansal audit → talep kararı tek primary [D1 batch transaction](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) içindedir. Pending talep, aktif satış, orijinal/geçerli ödeme, tam tutar, önizleme bakiyeleri, güvenli INTEGER toplamı ve referans kullanılabilirliği **yazma SQL’i içinde** yeniden denetlenir. Ön okumaya dayanıp koşulsuz finansal yazma yoktur. Herhangi bir SQL/constraint/audit hatası tamamını geri alır. İki adminin yarışında yalnızca biri yazar.

Audit PK kullanıcı/işlem/anahtar hash’i, canonical body digest’i ve transaction’a özel attempt kapısı kullanır. Aynı başarılı body/anahtar önceki sonucu döndürür; yeni karşı kayıt oluşturmaz. Farklı body aynı anahtarla 409’dur. Web belirsiz ağ/500/yanıt kaybında body ve anahtarı yalnızca kullanıcı kapsamlı bellekte saklar, alanları kilitler; otomatik yazma tekrarı yapmaz. Sayfa yenileme belleği kaybettirir; belirsiz sonuçta geçmiş incelenmeden yeni işlem başlatılmamalıdır. Kimlik/CSRF tokenı ve müşteri/tutar/gövde verisi Web Storage’a yazılmaz. Ayrı satış/tahsilat formu yalnızca opak idempotency UUID’sini sessionStorage’da korur; finansal onayda hedef ödeme/talep benzersizliği ve sonuç durumunun yeniden okunması aynı etkiyi ikinci kez engeller.

## Raporlar ve UI

Genel Bakış ve Tahsilat Raporu `adjustments` toplamlarını ayrı gösterir: `record_reversal_kurus/count`, `external_refund_kurus/count`, `reversal_cash/card/bank_kurus`, `refund_cash/card/bank_kurus`. Hareket tarihi adjustment’ın admin kayıt tarihidir. Geçerli tahsilatlar **asıl tahsilat tarihinde, bugünkü geçerliliğiyle** hesaplanır; sonradan ters kayıt geçmiş dönem geçerli tahsilatını değiştirir. Bu nedenle bu toplamlarla tarihsel net nakit akışı veya dönem kapanış muhasebesi hesaplanamaz; iadeler tekrar tahsilattan düşülmez. Çalışan raporu düzeltmeleri orijinal tahsildara değil uygulayan admine yazar, yalnızca düzeltme yapan admini de listeler. Son işlemler düzeltme türünü açık gösterir. Nakit/kart/banka ayrı izlenir; fiziksel kasa bakiyesi üretilmez.

React talep/onay öncesi bakiye önizlemesi, zorunlu iade teyidi/referansı, onaylayan/zaman/kalıcı geçmiş; satış detayında düzeltmeler ve müşteride tipli ledger sunar. Hata gerçek hata durumudur, sahte veriye geçilmez. Başarı yalnızca doğrulanmış API yanıtından sonra gösterilir. Web sidebar/mobil drawer korunur; native mobilin gelecekteki bottom navigation kararı web’e uygulanmaz.

## Migration ve doğrulama

`migrations/0002_financial_adjustments.sql` yalnızca ek tablo ve indeksler oluşturur; dokuz temel tabloyu/veriyi yeniden yazmaz. Kod bu tabloyu okuduğundan çalıştırılmadan önce operatörün uygun ortamda migration’ı uygulaması gerekir. Bu görevde **yalnızca OS geçici dizinindeki ayrı kimlikli izole test D1’e** uygulandı; mevcut yerel veya uzak D1’e uygulanmadı. Üretim için önce yedekleme ve mevcut migration durumunu inceleme gerekir; deploy yapılmadı.

`tests/adjustments.test.mjs` gerçek geçici Workers/D1 üzerinde yetki, önizleme/tam tutar, iki admin yarışı, idempotency, audit rollback, borç, iadeli iptal, eski reversal engeli, rapor/tarih/attribution ve geçmişi doğrular. `test:adjustments:browser` gerçek React → Vite proxy → API üzerinde employee talebi, admin teyidi, commit sonrası yanıt kaybı/aynı anahtarla tekrar, iptal ve borç, rapor ve API hata/yeniden denemeyi kapsar. Banka/POS sonucu, gerçek para iadesi ve üretim yükü bu testlerin kapsamı değildir.

## Değişen dosyalar ve sonuç

Bu aşamadan önce çalışma alanında bulunan rapor değişiklikleri korunmuştur; aşağıdaki liste finansal düzeltme kapsamında eklenen/genişletilen dosyalardır. Kök dokümanlar uygulama Git depolarının dışındadır.

| Alan | Dosyalar |
|---|---|
| API model/akış | `migrations/0002_financial_adjustments.sql`; `src/corrections/financial.ts`, `schemas.ts`, `repository.ts`, `endpoints.ts`; `src/finance/adjustments.ts`, `payments.ts`, `receivables.ts`, `schemas.ts`; `src/index.ts` |
| Rapor genişletmesi | API `src/reports/schemas.ts`, `repository.ts`; web `src/reports/AdjustmentMetrics.tsx`, `DashboardReport.tsx`, `ReportViews.tsx`, `src/services/reports.ts` |
| Web düzeltme/geçmiş | `src/services/adjustments.ts`, `corrections.ts`, `finance.ts`, `apiClient.ts`; `src/corrections/FinancialApproval.tsx`, `FinancialResult.tsx`, `CorrectionForm.tsx`, `CorrectionsPage.tsx`, `presentation.ts`, `corrections.css`; `src/finance/AdjustmentHistory.tsx`, `PaymentHistory.tsx`, `CustomerLedger.tsx`; `src/sales/SaleRecord.tsx` |
| Testler/komutlar | API `tests/adjustments.test.mjs`, `tests/auth.test.mjs`, `tests/report-environment.mjs`, `package.json`; web `tests/adjustments.browser.mjs`, `tests/run-auth.mjs`, `tests/serve-auth.mjs`, `package.json` |
| Belgeler | Kök `SKILLS.md`, `PROJE.md`, `MIMARI_TASARIM.md`, `PROMPTLAR.md`; API `README.md`, `docs/CORRECTIONS.md`, `FINANCIAL_ADJUSTMENTS.md`, `FINANCE.md`, `SALES.md`, `REPORTS.md`; web `README.md` |

Doğrulanan: **137 API testi** (104 önceki + 17 rapor + 16 finansal düzeltme), **5 tutar testi**, **63 tarayıcı kontrolü** (57 mevcut + 6 finansal düzeltme). Eşzamanlı onay, aynı anahtar/yanıt kaybı, eksik iade teyidi, stale bakiye, audit hatasında rollback, borç/ledger/rapor/geçmiş testleri gerçek izole yerel D1 üzerinde geçti. Sağlık kontrolü/proxy korunmuştur. Test ortamları temizlendi. Web/API TypeScript ve build, web lint ve mevcut web ESLint’iyle API kaynak/test Worker lint’i başarılıdır; API build yalnızca dry-run’dır. Üretilmiş web tip dosyasındaki önceden bulunan iki lint uyarısı sürer. Gerçek veri, mevcut yerel/uzak D1, deploy, commit/push ve paket kurulumu yapılmadı.
