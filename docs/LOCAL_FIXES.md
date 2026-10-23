# Yerel test hataları — 22 Ekim 2026

## Gerçek neden ve yerel onarım

Varsayılan `.wrangler/state/v3/d1` altındaki SQLite dosyası `mode=ro` ile incelendi: migration takibinde yalnızca `0001_initial_schema.sql` vardı; `financial_adjustments` tablosu yoktu. Boş ödeme/finansal hareket ve rapor okumalarının hata vermesinin, tahsilatın “doğrulanamadı” görünmesinin ortak nedeni buydu. Zod, TL/kuruş, müşteri/satış, cookie/CSRF veya Origin kontrolü gevşetilmedi.

Repo dışında `%LOCALAPPDATA%/AKCAT/backups/before-local-0002-20261022T163131Z.sqlite` dosyasına SQLite backup API'siyle WAL dahil tutarlı yedek alındı; `integrity_check` başarılıydı. Ardından yalnızca `wrangler d1 migrations apply akcat-db --local` ile mevcut `0002` uygulandı. Dokuz mevcut tablonun bütün satırları yedekle birebir karşılaştırıldı: değişiklik yok, foreign key ihlali yok. Yeni düzeltme tablosu boş. İş verisi veya gerçek hesap oluşturulmadı, değiştirilmedi, silinmedi. Uzak D1'e bağlanılmadı.

Tahsilat batch'i ödeme/audit ve yanıt SELECT'ini birlikte yürütür. Eksik tablo durumunu izole D1'de yeniden oluşturduk: POST hata verdi ve bütün batch geri alındı; hayalet ödeme/audit kalmadı. Migration sonrasında aynı anahtar ilkinde 201, tekrarında aynı kayda 200 verdi. Bu kanıt mevcut kullanıcının tarayıcı Network kaydının incelendiği anlamına gelmez; kullanıcı oturum bilgileri alınmadı veya kullanılmadı.

## Dört sorun ve değişen dosyalar

| Sorun | Düzeltme / dosyalar |
|---|---|
| Boş geçmiş hata gibi görünüyordu | Başarılı `data: []` ekranları zaten boş durumu ayırıyordu; asıl hata eksik şemaydı. `src/database/errors.ts` ve `src/index.ts` yalnızca bilinen eksik tabloyu güvenli `503 DATABASE_SCHEMA_REQUIRED` olarak sınıflandırır. Ham SQL/stack döndürmez veya loglamaz. Web `src/services/apiClient.ts` şema/hizmet/okuma hatasını boş başarıdan ayırır. |
| Tahsilat “doğrulanmadı” | Mevcut 0002 yerelde uygulandı; yeni migration yok. `src/finance/PaymentForm.tsx` kesin ret, hiç gönderilmeme, önceki anahtarla çatışma ve belirsiz sonuç başlıklarını ayırır. Başarı gerçek POST makbuzuna bağlıdır. Belirsizlikte body/anahtar kilidi ve aynı anahtarla tekrar korunur; boş geçmiş anahtarı otomatik bırakmaz. |
| Satıştan müşteriye bağlantı yoktu | `src/sales/SaleListPage.tsx` müşteri adını mevcut `customerHref(customer_id)` hash yönlendirmesine bağlar. Satış tarihindeki detay bağlantısı korunur. |
| Dashboard hareketleri görünmüyordu | Özet sorgusu da eksik 0002'ye bağlıydı. Ayrıca endpoint bilinçli olarak yalnızca bugünü döndürüyordu. `src/reports/DashboardReport.tsx` bugün/Türkiye saati/en son 10 kayıt sınırını ve geçmiş günler için rapor bağlantısını açıklar; gerçek sıfır sonuçta “Henüz işlem bulunmuyor.” gösterir. API'deki dönem, sıralama ve yetkiler değiştirilmedi. |

`package.json` içindeki `db:migrate:local` operatörün açıkça çalıştırdığı, yalnızca yerel mevcut migration komutudur. Sunucu başlatılırken otomatik migration/seed/reset yoktur. Kurulum bilgisi API README, FINANCE, REPORTS ve FINANCIAL_ADJUSTMENTS belgelerinde güncellendi.

## Kontrol kapsamı

Yeni `tests/local-fixes.test.mjs`: eksik şema okuma/yazma hatası, batch rollback, veri koruyan yükseltme, boş geçmişler, aynı anahtarla tekrar, geçerli CSRF, kısmi/tam tahsilat, yanlış tutar, müşteri uyuşmazlığı ve fazla tahsilat. `tests/finance.browser.mjs` boş geçmişleri, gerçek 422 ret başlığını ve üç genişlikte müşteri bağlantısını; `tests/reports.browser.mjs` sıfır dashboard ve İstanbul önceki gün sınırını; `tests/audit.browser.mjs` aynı anahtar/409 başlığını doğrular.

Regresyon koşumunda eski ters kayıt fixture'ı iki kez yanlış ara bakiye üretti, daha sonraki ayrı koşumda geçti. Node ve workerd tarihlerini aynı saat kabul eden doğrudan test SQL'i, gerçek düzeltme yazıcısındaki nedensel alt sınırı uygulamıyordu. `tests/finance.cases.mjs` fixture zamanı artık asıl ödeme ve satış zamanından önce olamaz; hedef satış da açıkça kontrol edilir. Üretim finansal hesap/sıralama modeli değiştirilmedi.

- API `npm.cmd test`: **148/148** (145 mevcut + 3 yeni entegrasyon testi). Önceki başarısız koşumlar yukarıda açıklanan test fixture düzeltmesinden önceydi; son tam koşum hatasız.
- Web tutar/satış hesabı/API origin: **8/8**.
- Tarayıcı: **71/71** (auth 13, müşteri 10, ürün 9, satış 7, tahsilat 8, düzeltme 6, rapor 7, iade 6, audit 5). Her suite ayrı geçici D1'de gerçek React/Vite proxy/API ile çalıştı.
- API TypeScript ve web build içindeki TypeScript başarılı. Web/API lint: 0 hata; üretilmiş web `worker-configuration.d.ts` dosyasında önceden bulunan 2 uyarı korunuyor.
- Web build ve API build başarılı. API build yalnızca `wrangler deploy --dry-run`, gerçek deploy değildir.
- 320/390/1440 px ilgili form, geçmiş, dashboard, hata ve müşteri bağlantısı kontrolleri başarılı; yatay taşma/tarayıcı JavaScript hatası yok. Audit paketi ayrıca 768/1024 px ve drawer odak/Escape/kaydırma kilidini doğruladı.
- İlgili Git diff whitespace kontrolleri başarılı; test ortamları kapatılıp geçici durumları temizlendi. Repo dışındaki yerel veri yedeği korundu.

## Sınırlar

Mevcut `http://localhost:8787/api/health` yanıtı `status: ok, database: connected` olarak salt okunur doğrulandı. Kullanıcının gerçek oturumuyla satış/tahsilat yazması yapılmadı; bütün fonksiyonel yazma testleri farklı kimlikli geçici D1'deydi. Uzak Cloudflare, deploy, yeni paket, commit/push ve tasarım yeniden yapılandırması yoktur. Sidebar/drawer ve native mobil navigasyon kararı korunur. Geçmişi boş görmek belirsiz işlemin başarısız olduğunun kanıtı değildir; aynı işlem anahtarını kullanın, ayrı yeni kayıt oluşturmayın.
