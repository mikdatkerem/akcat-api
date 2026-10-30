# Altı aşamalı güvenilirlik iyileştirmesi — 30.10.2026

## Sözleşme değişiklikleri

### Satış fiyatı

Katalog fiyatıyla satılan her kalem `expected_list_price_kurus` gönderir. Yeni satışta hem bu alan hem özel `unit_price_kurus` yoksa `428 PRICE_CONFIRMATION_REQUIRED` döner. Daha önce tamamlanmış eski bir isteğin orijinal anahtar/gövdeyle tekrarı okunabilir; yeniden fiyatlandırma yapılmaz.

Beklenti atomik INSERT içindeki güncel fiyatla uyuşmuyorsa satış, kalem, ilk ödeme ve audit yazılmaz. `409 PRICE_CHANGED` yanıtı:

```json
{"error":{"code":"PRICE_CHANGED","message":"Ürün fiyatı değişti. Yeni tutarı kontrol edip tekrar onaylayın.","details":{"products":[{"product_id":"ürünün UUID değeri","name":"ürünün gerçek adı","expected_list_price_kurus":10000,"current_price_kurus":12000}]}}}
```

Bu yalnızca sözleşme örneğidir; uygulamaya iş verisi eklenmez. Web taslağı korur; kullanıcı yeni fiyatı kabul edince toplamı yeniden görür ve ayrı bir Kaydet ile onaylar. Özel fiyat gönderilmişse katalog değişikliği bu fiyatı değiştirmez; liste snapshot’ı yazma anındaki gerçek katalog fiyatıdır. Toplamlar sunucuda tam sayı kuruşla yeniden hesaplanır.

### Kritik yazmalarda yetki

`src/security/authorizedBatch.ts` ilk SQL ifadesinde aktif kullanıcıyı, middleware sırasında görülen rolün hâlâ aynı olduğunu ve o kullanıcıya ait iptal edilmemiş/süresi dolmamış oturumu denetler. Oturum süresi SQLite `julianday('now')` ile batch çalışırken kontrol edilir. Yetki reddinde yalnızca o dala girildiğinde değerlendirilen işaretli geçersiz JSON yolu SQL hatası üretir. D1 bütün batch’i geri alır; bilinen işaretli hata `403 FORBIDDEN` olarak çevrilir. Başka DB hataları 403 diye gizlenmez.

Satış, tahsilat, doğrudan iptal, düzeltme oluşturma/onay/ret, finansal ters kayıt/iade onayı, ürün/müşteri oluşturma/düzenleme/silme ve kullanıcı oluşturma/düzenleme/reset/silme bu denetimi kullanır. Middleware rol, Origin, CSRF ve mevcut kullanıcı yönetimi koşulları da korunur. Ön kontrol SELECT’i tek başına güvenlik sınırı değildir.

**Sıralama:** Aynı D1 veritabanında yetki iptali önce commit ederse sonraki yazma batch’i reddedilir. Yazma önce commit ederse daha sonra yapılan yetki iptali geçmişte tamamlanmış işlemi geri almaz. İstemcinin isteği başlatma zamanı veya bağlantıyı kesmesi commit sırasını belirlemez. Dayanak: [Cloudflare D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) ve [yabancı anahtar davranışı](https://developers.cloudflare.com/d1/sql-api/foreign-keys/).

### Müşteri/ürün PATCH

`0004_record_versions.sql`, mevcut kayıtlara `version INTEGER NOT NULL DEFAULT 1` ekler. Tip ve güvenli pozitif tam sayı sınırı CHECK ile korunur. Eski migration’lar ve finansal kayıtlar değiştirilmez.

GET/liste yanıtları `version` içerir. PATCH, `expected_version` ve UUID `Idempotency-Key` ister. Şema doğrulamasından geçen gövdede sürüm eksikse `428 VERSION_REQUIRED`, eski sürümde `409 RECORD_VERSION_CONFLICT` döner; key eksik/geçersizse 400’dür. Alan değişikliği, sürüm artırma ve audit aynı batch’tedir. Sürüm üst sınırında korumasız yazma yapılmaz.

Anahtar kullanıcı/kaynak/eylem kapsamındadır; fingerprint hedef ID, beklenen sürüm ve sıralı normalize alanları içerir. Aynı isteğin tekrarı alanları/sürümü yeniden yazmaz; **güncel kayıt** döner. Böylece sonradan yapılan düzenleme eski tekrar tarafından ezilmez. Farklı gövde aynı key ile 409; sonradan silinen kayıt için ilgili `*_DELETED` çakışması döner. Audit/idempotency kayıtları silinmemelidir.

Form çakışmada yazılan alanları korur. “Güncel bilgileri yükle”, kullanıcının değiştirdiği alanları koruyup diğer alanları günceller; sunucudaki değerler karşılaştırma için açılabilir. Yeniden Kaydet açık onaydır. Belirsiz PATCH yanıtında gövde/sürüm/key bellekte kilitlenir ve aynı istek tekrarlanır. Aktiflik eylemleri de sürüm ve key gönderir.

### Fiyat geçmişi

Ürün fiyatı PATCH audit’i eski fiyatı DB satırından, yeni fiyatı doğrulanmış istekten alır; yeni JSON fiyatı SQL’de INTEGER’a dönüştürülür. Değerler güncelleme öncesi aynı batch’te kaydedilir. Ürün adı/aktiflik değişiklikleri veya aynı fiyatı yazmak fiyat değişikliği sayılmaz.

Admin: `GET /api/v1/products/:id/price-history?page=1&pageSize=10`. En yeni audit önce gelir; sayfa boyutu 1–100’dür. Yanıt alanları `id`, `old_price_kurus`, `new_price_kurus`, `actor_user_id`, `username`, `created_at` ve ortak `pagination`’dır. Kullanıcı adı mevcut hesaptan okunur; kalıcı ilişki actor ID’dir. Eski/yeni fiyatı bulunmayan audit’lerden geçmiş uydurulmaz. Employee arayüzü bu isteği göndermez; endpoint de admin ister.

## Oturum ve iptal penceresi

İlk oturum kontrolünde korumalı ağaç gösterilmez. Doğrulanmış oturumun arka plan kontrolünde mevcut ağaç korunur; geçici ağ hatası uyarı verir, formu kaldırmaz. 401 oturumu ve korumalı içeriği kaldırır. Rol değişimi gerekli arayüz yetkilerini günceller. Parola/token veya hassas form verisi kalıcı depolamaya eklenmez.

Satış iptali gönderilirken Escape, backdrop ve Vazgeç engellenir; durum metni görünür. Başarısızlıkta pencere açık kalır. Başarı gerçek yanıtla uygulanır. Mevcut finansal onay formunun Vazgeç düğmesi de gönderim sırasında kilitlidir; ona ait Escape/backdrop kapanışı yoktur. Fetch iptalinin DB işlemini geri aldığı varsayılmaz.

## Test izolasyonu ve çalıştırma

Testler `tests/wrangler.jsonc`, yalnızca `11111111-1111-4111-8111-111111111111` test DB kimliği, `--local`, loopback ve OS geçici dizini kullanır. Remote binding reddedilir. Test Worker’ının kontrol uçları rastgele test anahtarı ister ve üretim entrypoint’ine eklenmez. Fixture’lar yalnızca bu geçici DB’lerdedir.

`tests/migration-source.mjs` normal testlerde numaralı SQL dosyalarını sırayla yükler; yinelenen numarayı ve izinli sıralı prefix dışında eski şema seçimini reddeder. Audit/yerel hata testleri 0001 tarihsel fixture’ını güncel şemaya yükseltir; CLI testi migration takip tablosunu ve tekrar uygulamanın no-op olmasını doğrular. Yabancı anahtarlar kapatılmaz.

- API: `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run build` (yalnızca Wrangler dry-run).
- API lint: web’de kurulu ESLint ve mevcut yapılandırma ile `src` ve test Worker’ı; API’de ayrı lint script’i yoktur.
- Web: `npm.cmd run lint`, `npm.cmd run build`; mevcut dört Node test dosyası.
- İzole tarayıcı: `node tests/run-isolated.mjs --suite all --playwright-dir <kurulu-playwright-paket-dizini>`. Her suite yeni geçici DB açıp kapatır; paket/tarayıcı kurmaz. Tek suite veya virgülle ayrılmış seçim desteklenir. `reliability` yeni fiyat, form, modal, sürüm, kayıp yanıt ve geçmiş akışlarını doğrular.

Güncel gerçek sonuçlar kökteki `IYILESTIRME_RAPORU.md` içindedir. Önceki modül belgelerindeki eski test sayıları bu sürümün kanıtı sayılmaz.

## Kontrollü canlıya geçiş — operatör tarafından, otomatik uygulanmadı

1. Üretim yedeği ve geri yükleme sorumlusu doğrulansın. Aynı commit seti ayrı staging/izole ortamda doğrulansın.
2. Yazma trafiği kontrollü bakım süresinde durdurulsun; eski API istekleri bitmeden yeni sözleşmeye geçilmesin. Taslak sahipleri işlem sonuçlarını geçmişten kontrol etsin.
3. Yetkili operatör doğru D1 kimliğini kontrol ederek bekleyen migration’ları sırasıyla uygulasın; 0001/0002/0003 değiştirilmez, yalnızca bekleyen 0004 eklenir. `/api/health` bağlantı kontrolüdür; şema kontrolü değildir.
4. Yeni API ve ardından yeni web birlikte devreye alınsın; Service Binding, Workers route ve doğrudan API erişiminin kapalı olduğu panelden doğrulansın. Kullanıcılar tam yenilemeyle yeni web sürümünü alsın.
5. Yeni API/eski web ile yeni katalog fiyatlı satışlar 428, sürümsüz PATCH istekleri 400/428 alır. Bu beklenen güvenli reddir. Yeni web/eski API desteklenmez; eski API beklenen fiyatı kontrol etmez ve sürümü artırmaz. Karışık sürümlerde yazma trafiği açılmasın.
6. Admin/employee girişleri, bir fiyat çakışması, sürüm çakışması, gerçek izinli işlem ve audit doğrulandıktan sonra yazmalar açılsın. Gerçek hesap oluşturma/test verisi ekleme otomatik yapılmaz.
7. Geri dönüşte önce yazmalar durdurulsun; API/web uyumlu bir sürüm çifti olarak ele alınsın. 0004 sütunları silinmesin, finansal geçmiş yeniden hesaplanmasın. Eski API’ye dönmek bu güvenlik düzeltmelerini kaldırır; yeni web’le karışık çalıştırılmasın.

## Sınırlar

Üretim erişim ayarları, gerçek edge eşzamanlılığı/kapasitesi ve yedekten geri dönüş bu yerel testlerle doğrulanmaz. Tam sayfa yenileme/sekme kapatma müşteri/ürün taslağını korumaz; hassas veriyi kalıcılaştıran yeni çözüm eklenmedi. Katalog fiyatı değişip aynı değere geri dönerse parasal beklenti eşleşir; fiyat sürümünün bütün ara tarihçesini kontrol etme garantisi verilmez. Audit geçmişi yalnızca yeni kayıt formatından itibaren güvenilir eski/yeni fiyat içerir.
