# Üretim öncesi güvenlik ve kalite denetimi — 22 Ekim 2026

**Karar: hazır değil.** Yerel iş akışları ve regresyonlar başarılı olsa da uzak D1 şeması, gerçek edge kaynak/TLS ölçümleri, adresleme ve kişiye özel hesap sağlama tamamlanmadan işletme trafiği açılmamalıdır. Bu bir deploy veya canlıya geçiş onayı değildir. Manuel işlemler: [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md).

## Bulgular

| Seviye / ID | Bulgu ve kanıt | Durum / gereken eylem |
|---|---|---|
| Kritik | İncelenen kapsamda doğrulanmış kritik yetki atlama, SQL injection, saklanmış sır veya finansal atomiklik ihlali saptanmadı. | Bu ifade bağımsız pentest veya mutlak güvenlik garantisi değildir. |
| Yüksek H1 | Uzak D1’de salt okunur `sqlite_master` / `d1_migrations` sorguları yalnızca `0001_initial_schema.sql` ve dokuz temel tabloyu gösterdi. `financial_adjustments` yok. Yeni ödeme/rapor sorguları bu tabloya bağlı. | **Açık, çıkış engeli.** Yedek/kurtarma kontrolünden sonra operatör 0002’yi uygulamalı. Bu denetim uygulamadı. Health `SELECT 1` bu eksikliği tespit etmez. |
| Yüksek H2 | Scrypt güvenli parametrelerle kullanılıyor; gerçek Cloudflare edge CPU/bellek ve dört eşzamanlı giriş ölçülmedi. Free HTTP CPU bütçesi 10 ms. | **Açık, çıkış engeli.** Free uygun kabul edilmez. Paid bütçesi ve gerçek staging ölçümü gerekli; KDF zayıflatılmadı. |
| Yüksek H3 | Uzak salt okunur sorguda aktif admin ve bootstrap kilidi yok. Üründe employee oluşturma ve güvenli hesap/parola kurtarma akışı yok. | **Açık, işletim engeli.** İlk admin yalnızca operatör bootstrap’ıyla; 3–4 kişilik kullanım için ayrı audit’li hesap sağlama/iptal yöntemi tamamlanmalı. Ortak admin paylaşılmaz. Hesap oluşturulmadı. |
| Yüksek H4 | Kaynak `wrangler.jsonc` origin allowlist’i boş bırakıyor; gerçek üretim web/API adresi ve route/HTTPS düzeni doğrulanmış değil. Boş allowlist auth’u güvenli 503 ile kapatır. | **Açık, çıkış engeli.** Gerçek adresler, exact origin, cookie ve routing operatör tarafından staging’de doğrulanmalı. Uzak Worker ayarlarının tamamı sorgulanmadı. |
| Yüksek H5 | Satış/tahsilat işlem anahtarı yalnızca JS belleğindeydi; commit sonrası yanıt kaybı ve tam reload önceki anahtarı kaybettiriyordu. Yeni anahtarla elle tekrar giriş mükerrer kayıt riski taşıyordu. | **Yerelde düzeltildi.** Yalnızca opak idempotency UUID’si kullanıcı/işlem kapsamlı sessionStorage’da korunuyor. Aynı body tek kayda döner; farklı body 409; ayrı yeni işlem için açık geçmiş kontrolü teyidi gerekir. Depolama engelinde POST gönderilmez. |
| Yüksek H6 | Merkezi API adresi üretim için HTTP/localhost veya URL içi kimlik bilgisiyle build edilebiliyordu. Doküman uyarısı dışında doğrulama yoktu. | **Yerelde düzeltildi.** `apiOrigin.ts` Vite build öncesinde ve istemcide origin’i doğrular. Üretimde HTTP, loopback alternatifleri, kullanıcı bilgisi, path/query/hash reddedilir. |
| Orta M1 | Rate limit konum bazlı/yaklaşık; küresel sert sayaç değildir. Admin MFA, idle timeout, self-service parola değiştirme/kurtarma ve tüm cihazlardan çıkış yok. | WAF/bot ve hesap yaşam döngüsü politikası gerekli. 8 saat sabit oturum açıkça belgelenmiş; güvenlik gevşetilmedi. |
| Orta M2 | Web statik yanıtında açık CSP/frame-ancestors politikası yok. Uygulama logları veri yazmasa da Cloudflare invocation URL/query kayıtları arama metni/kimlik içerebilir. | Gerçek origin’lerle uyumlu CSP/anti-framing, log erişim/saklama ve URL veri minimizasyonu üretim hardening işi olarak açık. Varsayımsal XSS açığı varmış gibi raporlanmadı; React metin kaçışı test edildi. |
| Orta M3 | Satış ve geçerli tahsilat raporları güncel geçerlilikle eski dönemleri yeniden değerlendirir; fiziksel kasa/kapanış, sabit tarihsel muhasebe snapshot’ı veya otomatik banka doğrulaması yok. | Bilinen ürün sınırı. İade/toplamlar çift düşülmez; bunlardan dönemsel net nakit akışı veya kasa bakiyesi üretilemez. Kısmi/farklı yöntemle iade desteklenmez. |
| Orta M4 | Global borç CTE’si tüm geçerli ödemeleri/satışları aggregate eder; offset pagination ve substring arama veri büyüdükçe daha fazla satır okur. | Mevcut ölçek için kapsamlı yeniden yapılandırma yapılmadı. D1 rows_read ve yıllık veri büyüklüğü edge’de ölçülmeli; ölçüme göre bileşik indeks gerekebilir. |
| Orta M5 | sessionStorage sekme kapatma/veri temizleme veya başka cihazlar arasında dayanıklı işlem günlüğü değildir. Düzeltme taleplerinin body/anahtarı hâlâ bellektedir; finansal tekrar etkisi hedef talep/ödeme UNIQUE koşullarıyla korunur. | Belirsiz durumda geçmiş uzlaştırması zorunlu. Otomatik yeni anahtar/para transferi yok. İşlem UUID’si bir kimlik doğrulama tokenı değildir; müşteri/tutar/gövde saklanmaz. |
| Düşük L1 | Üretilmiş web `worker-configuration.d.ts` dosyasında önceden bulunan iki gereksiz eslint-disable uyarısı var. | Lint hatası yok; üretilmiş dosyaya elle müdahale edilmedi. |
| Düşük L2 | Önceki modül dokümanlarında eski test sayıları ve artık geçerli olmayan ödeme/onay ifadeleri vardı. | İlgili çalışma/saklama sözleşmeleri güncellendi; eski sonuçlar tarihsel modül sonuçları olarak korunur. Güncel denetim sonucu bu belgededir. |

## Güvenlik incelemesi

Scrypt `N=16384,r=8,p=5`, 16 bayt salt, 32 bayt digest, KDF `maxmem=32MiB` kullanır. Parametreler sürümlü ve sabittir; veritabanı hash’i keyfi maliyet yükleyemez. Bu parametre seti OWASP’ın scrypt alternatifleri arasındadır. Eksik/pasif/yanlış parola aynı KDF yolunu kullanır; digest karşılaştırması sabit uzunlukta yapılır. [OWASP parola saklama](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

`compatibility_date=2026-10-19` için Node.js uyumluluğu güncel Workers davranışında varsayılan açıktır; ayrıca flag eklemek gerekmedi. `node:crypto` scrypt destekli, Argon2 destekli değildir. API’nin kilitli Zod sürümü 4.6.7; güncel bellek önerisindeki 4.5+ eşiğinin üzerindedir. [Workers crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/), [Workers kaynak limitleri](https://developers.cloudflare.com/workers/platform/limits/).

Oturum tokenı 32 rastgele bayttır; ham token D1/audit’e yazılmaz, SHA-256 hash’i saklanır. Üretimde `__Host-`, HttpOnly, Secure, SameSite=Lax, Path=/ ve Domain’siz cookie; 8 saat sabit son kullanma ve sunucu logout iptali vardır. CSRF oturum tokenına bağlı HMAC; cookie yazmalarında hem CSRF hem exact Origin zorunludur. Wildcard CORS yoktur. Rol/aktiflik her korumalı istekte D1 primary’den okunur. Mobil Bearer varsayılan kapalıdır ve ayrı önek kullanır; gelecekteki native API erişimine mimari engel bulunmadı.

OpenAPI’de tanımlı bütün korumalı iş operasyonları için oturumsuz isteklerin 401 verdiği yeni testle doğrulandı; admin yazmaları/çalışan yönetim raporu employee için 403. Ortak şirket müşteri/satış/tahsilat görünürlüğü tasarlanmış davranıştır. Polimorfik correction target ilişkisi SQL FK değildir; API hedef varlığını transaction içinde denetler ve hedefler fiziksel silinmez. Genel serbest SQL, delete veya bootstrap HTTP rotası yoktur.

SQL değerleri bağlı parametre; dinamik sütun/sıralama/parçalar sabit whitelist’lerdendir. React kullanıcı metnini HTML olarak çalıştırmaz; izole müşteri HTML payload’ı DOM’da metin kaldı. API istisnaları body/cookie/token/SQL/stack loglamaz ve güvenli mesaj döner. Public OpenAPI arayüzü sözleşmeyi açar, iş verisini veya yetkiyi açmaz.

Git’in takip ettiği 158 metin dosyasında özel anahtar ve yaygın credential/token kalıpları tarandı; eşleşme ve takip edilen özel `.env`/`.dev.vars` bulunmadı. Yerel sır dosyaları açılıp rapora kopyalanmadı; Git geçmişi ve hesap secret envanteri bu tarama kapsamında değildi. API ve web `npm audit --json`: bilinen advisory bulgusu 0; paket kurulmadı veya güncellenmedi.

## Mimari ve üretim bağlantısı

API bağımsız Workers/Hono/Chanfana/D1 projesidir; web runtime’ına bağlı değildir. Mevcut lint kontrolünün web ESLint’ini kullanması API runtime bağımlılığı oluşturmaz. D1’e yalnızca API erişir. Vite proxy yalnızca `dev` sunucusundadır. Üretim web Worker’ı API üretmez, API yollarını SPA HTML’iyle örtmez; yanlış yönlendirmede 404 verir. Aynı origin route’u veya aynı site altında açık HTTPS API origin’i operatör tarafından kurulmalıdır. Tasarım tokenları ve web sidebar/mobil drawer korundu; native mobil için bottom navigation ayrı karardır.

## D1 ve finansal tutarlılık

Sıfırdan 0001+0002 uygulaması mevcut regresyonların başlangıcında; 0001’de gerçek API fixture satışları varken 0002’ye geçiş yeni audit testinde doğrulandı. Geçişte satış/kalem/tahsilat/audit satırları birebir aynı kaldı. FK ihlali ve aynı asıl ödeme/talep/karşı kayıt tekrarları DB kısıtlarında reddedildi. Ham migration ikinci kez hata vererek veriyi korudu; Wrangler `d1_migrations` üzerinden tekrar apply no-op oldu. Uzakta hiçbir migration veya schema yazması yapılmadı.

Tam zincir: 500 TL satış → 100 TL ilk ödeme → 400 TL borç → 250 TL tahsilat → 150 TL borç → ilk ödemenin 100 TL hatalı kayıt ters kaydı → 250 TL borç → 250 TL admin teyitli harici iade → 500 TL borç → ayrı iptal onayı → 0. Her adımda müşteri açık satışları, ledger son bakiyesi, borçlu listesi, borç raporu ve Genel Bakış aynı sonucu verdi. Bunlar yalnızca izole test işlemleridir; gerçek para hareketi değildir.

Snapshot fiyat/adı katalog güncellemesinden etkilenmedi. Dört eşzamanlı 150 TL tahsilat 500 TL borca karşı üç başarı/bir ret üretti; fazla tahsilat oluşmadı. Yeni/eski testler; çift onay, collection/cancel yarışı, audit hatasında rollback, CSRF/Origin/rol, safe INTEGER sınırı, idempotency ve orijinal geçmişi doğrular. Ters kayıt/iade asıl ödemeye bağlı pozitif satır + tipli adjustment’tır; negatif ödeme veya fiziksel silme yoktur. D1 batch atomikliği güncel dokümanla doğrulandı. [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

Uzak salt okunur özet: foreign key ihlali, ödeme–satış müşteri uyuşmazlığı ve geçersiz ürün fiyatı sayıları 0; aktif admin/kurulum kilidi yok. Bu sınırlı sorgular gerçek uçtan uca işletme testi veya bütün tarihsel finansal kayıtların bağımsız denetimi değildir. Time Travel info bookmark erişimi başarılıydı; restore/export yapılmadı. Şema eksikliği nedeniyle yeni sürümün uzak finansal sorguları başarılı varsayılmaz.

## Ölçülen performans ve sınırlar

Yerel Windows Node 22.13.1 scrypt probu: üç doğrulama CPU 406/391/344 ms; wall 395/423/418 ms. Dört eşzamanlı doğrulama toplam process CPU 1781 ms, wall 505 ms; önce/sonra RSS 56 MiB. Bunlar gerçek Workers billed CPU veya isolate tepe belleği değildir; maxmem de bütün Worker belleği değildir. Free uygunluğu bu ölçümden çıkarılamaz; üretim kapısı gerçek Paid/edge ölçümüdür. CPU/bellek sınırları ve staging kabulü runbook’ta tanımlıdır.

`npm.cmd run audit:performance`, ayrı yerel Workers/D1’de **2.000 sentetik satış + 2.000 ödeme + 100 müşteri / 4 employee ve 1 admin fixture hesabı** ile çalıştı ve temizlendi. Son koşumda üç sıcak HTTP örneği: summary 61/67/69 ms; receivables 138/177/185 ms; payments 44/51/48 ms; employees 30/41/34 ms; müşteri ledger 59/69/81 ms. Dört eşzamanlı summary 102/304/304/304 ms; burst tamamı 306 ms. Satış tarih indeksi kullanıldı; listeler 20 kayıtla sınırlıydı. Ölçüm yerel makinede diğer kontrollerle birlikte yapıldı; üç örnekle p95/kapasite iddiası kurulmaz. Gerçek ağ, yıllık veri hacmi, edge CPU/bellek ve faturalama okuma bütçesi ölçülmedi. Gereksiz cache/framework/şema değişikliği yapılmadı.

## Gerçek kontrol sonuçları

- API: **145/145** test (137 mevcut + 7 güvenlik/finans/migration geçişi + 1 gerçek yerel Wrangler migration tracker testi).
- Web hesaplama/config: **8/8** test (5 tutar + 3 API origin).
- Tarayıcı: **68/68** kontrol (auth 13, müşteri 10, ürün 9, satış 7, tahsilat 6, düzeltme 6, rapor 6, iade 6, yeni audit 5). Gerçek React/proxy/API, ayrı geçici yerel D1 kullanıldı; test ortamları kapatılıp temizlendi.
- Yeni tarayıcı kontrolleri: commit sonrası kayıp yanıt + tam reload, aynı UUID ile tek satış/tahsilat, farklı body reddi, geçmiş kontrolü kapısı, depolama engelinde yazmama, React metin kaçışı. 320/390/768/1024/1440 px form/hata/tutar/iade onayı, drawer odak/Escape/scroll kilidi doğrulandı.
- API TypeScript ve web build içindeki TypeScript başarılı. Web/API lint: 0 hata; web üretilmiş tip dosyasında önceden bulunan 2 uyarı var. Web build ve API build başarılı; API build yalnızca dry-run’dır, gerçek deploy testi değildir.
- HTTP/localhost API origin’iyle gerçek üretim build’i beklendiği gibi reddedildi. Üretim bundle’larında test kontrol rotası/anahtar başlığı ve örnek Task rotası bulunmadı; istemci bundle’ında yerel proxy hedefi yok. Her iki repo için `git diff --check` başarılı.
- Paket kurulumu, lockfile güncellemesi, üretim verisi, uzak migration/admin, para hareketi, commit/push ve GitHub otomasyonu yoktur. Başlangıçtaki kaydedilmemiş değişiklikler korunur.

## Bu denetimin yerel değişiklikleri

Web: `src/config/apiOrigin.ts`, `api.ts`, `vite.config.ts`, `.env.example`; `src/finance/pendingKey.ts`, `RecoveryNotice.tsx`, `draft.ts`, `PaymentForm.tsx`; `src/sales/draft.ts`, `SaleForm.tsx`; `tests/api-origin.test.mjs`, `audit.browser.mjs`, `run-auth.mjs`, `package.json`.

API: yalnızca test/probe/komutlar (`tests/audit.test.mjs`, `migrations.test.mjs`, `performance-audit.mjs`, `report-environment.mjs`, `package.json`) ve belgeler değişti; auth veya finansal kayıt modeli yeniden yazılmadı, yeni migration eklenmedi. API/web README, AUTH/SALES/FINANCE/CORRECTIONS/FINANCIAL_ADJUSTMENTS belgeleri ve kök mimari, yeni UUID saklama ve çıkış kapılarını açıklamak için güncellendi. Bu rapor ve runbook yenidir.
