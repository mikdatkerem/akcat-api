# Ürün yönetimi API sözleşmesi

Mevcut `products` ve `audit_logs` kullanılır. Yeni migration, kategori, stok, barkod veya depo alanı yoktur. `admin` oluşturur/düzenler ve geçmiş satışlarda hiç kullanılmamış ürünleri kalıcı silebilir; `employee` yalnızca liste/detay okur. Yetki mevcut authentication middleware’iyle API’de denetlenir.

| Metot / yol | İstek | Yanıt |
|---|---|---|
| `GET /api/v1/products` | `q`, `status=all/active/inactive`, `page`, `pageSize` | `{data:Product[],pagination:{page,pageSize,total,totalPages}}` |
| `GET /api/v1/products/:id` | UUID | `200 {data:Product}` |
| `POST /api/v1/products` | JSON + UUID `Idempotency-Key`; admin | İlk istek `201 {data:Product}`, tekrar `200` |
| `PATCH /api/v1/products/:id` | En az bir izinli JSON alanı; admin | `200 {data:Product}` |
| `DELETE /api/v1/products/:id` | UUID + UUID `Idempotency-Key`; admin; gövde yok | `200 {success:true,id}`; geçmiş satışta kullanım `409 PRODUCT_IN_USE` |

`Product`: `id`, `name`, `current_price_kurus`, boolean `is_active`, UTC ISO `created_at` / `updated_at`. Yazılabilir alanlar yalnızca `name`, `current_price_kurus`, `is_active`. Oluşturmada ad/fiyat zorunlu; aktiflik varsayılanı `true`. PATCH gönderilmeyen alanları korur. Ad kırpılır, NFC normalize edilir, 1–160 karakterdir; kontrol karakterleri reddedilir. Fiyat JSON number olarak **0–9007199254740991 arasında tam sayı kuruş** olmalıdır. Negatif, kesirli, string/null ve güvenli tam sayı sınırını aşan fiyatlar reddedilir. Sıfır fiyat geçerlidir. Bilinmeyen alanlar reddedilir; gövde sınırı 16 KiB.

Liste varsayılanı tüm durumlar, sayfa 1, boyut 20. Sayfa 1–100000, boyut 1–100, arama en fazla 100 karakter. Ad araması Türkçe harf dönüşümlerini destekler; `%`, `_` ve SQL parçaları literal alt dizidir. Girdiler SQL parametresine bağlanır. Sıralama `created_at DESC, id DESC`; sayım/sayfa aynı D1 batch’inde okunur. Boş sonuç gerçek pagination ve `data:[]` döndürür. Farklı sayfa istekleri arasında snapshot garantisi yoktur; büyük kataloglarda substring araması ayrıca optimize edilebilir.

## İşlem güvenliği

[AUTH.md](AUTH.md) değişmez. Cookie yazmaları oturum, tam izinli Origin ve `X-CSRF-Token` ister. POST/PATCH JSON’dur; DELETE gövdesizdir. Ürün CORS sınırı aynı origin allowlist üzerinde GET/POST/PATCH/DELETE/OPTIONS ve gerekli başlıkları açar; yanıtlar `no-store`. 400 doğrulama, 401 oturum, 403 yetki/CSRF, 404 ürün yok, 409 kullanım/idempotency çakışması, 413 boyut, 415 içerik tipi, 500 beklenmeyen hatadır. SQL, stack veya kimlik bilgisi döndürülmez.

İstemci form başına UUID üretir ve yeniden denemede korur. Mevcut audit PK’si `product:create:` öneki + kullanıcı/anahtar hash’iyle işlemi belirler. Aynı normalize body/anahtar eşzamanlı veya ardışık gönderilince tek ürün ve tek oluşturma audit’i oluşur; farklı body aynı anahtarla 409 verir. Kullanıcılar ve müşteri oluşturma işlemleri ayrı kapsamdadır. Yeni anahtar yeni işlemdir; ürün adları benzersiz olmak zorunda değildir. Yanıt kaybolduktan sonra bilgileri değiştirmeden tekrar deneyin; çakışmada önce ürün listesini kontrol edin. Audit/idempotency kayıtları silinmemelidir.

Ürün yazması ve `product.created` / `product.updated` audit’i aynı atomik [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) içindedir; audit hatası ürünü de geri alır. Audit actor, entity, UTC zaman, alan adları ve oluşturma request hash’ini içerir; cookie/token/parola içermez. PATCH eşzamanlı düzenlemelerinde son yazma geçerlidir; sürüm/ETag arayüzü yoktur.

### Kalıcı silme

Aktif veya pasif olması silme uygunluğunu değiştirmez. `sale_items.product_id` referansı olan ürün, satış iptal edilmiş olsa bile silinemez. Tahsilat/düzeltme kayıtları satışlara bağlıdır; bunlar ve satış snapshot'ları değiştirilmez. Mevcut yabancı anahtarlar korunur; CASCADE/constraint kapatma yoktur. Ürün referansı kontrolü, güncel aktif admin/oturum kontrolü, ürün snapshot'ını taşıyan `product.deleted` audit'i ve DELETE aynı primary D1 batch'inde yürür. Satış önce yazılırsa silme reddedilir; silme önce tamamlanırsa yeni satışın mevcut/aktif ürün doğrulaması reddeder. Herhangi bir yabancı anahtar hatası batch'in tamamını geri alır ve `409 PRODUCT_IN_USE` döner.

Silme audit anahtarı `product:delete:` + kullanıcı/UUID hash'idir. Aynı kullanıcı/anahtar/ürün tekrarında `200` döner; başka ürünle aynı anahtar `409 IDEMPOTENCY_CONFLICT`, farklı anahtarla bulunmayan ürün `404 PRODUCT_NOT_FOUND` olur. Audit silinmez. Daha sonra silinmiş ürünün eski oluşturma anahtarıyla tekrarı yeni ürün üretmez; `409 PRODUCT_DELETED` döner. Web anahtarı belirsiz yanıttan sonra aynı satırdaki yeniden denemelerde bellekte korur; sayfa yenilendiyse önce liste kontrol edilir.

Web'de yalnızca admin'in gördüğü İşlemler menüsü düzenle, aktif/pasif yap ve sil seçeneklerini sunar. Silme odak yönetimli native dialog ile onaylanır; istek sürerken çift gönderim/kapatma engellenir. Başarılı işlem listeyi yeniden yükler. Kullanılmış ürün hatası pasife alma seçeneğini açıklar. Employee bu kontrollere sahip değildir; doğrudan DELETE isteği de API tarafından reddedilir.

## Para ve tarihsel güvenlik

Web `src/utils/format.ts` TL metnini regex + BigInt ile kuruşa çevirir; ondalıklı çarpma/yuvarlama kullanılmaz. Girişte binlik ayırıcı kullanılmaz; virgül/nokta ve en fazla iki ondalık basamak kabul edilir. Türkçe gösterim `formatMoney` ile yapılır. `19,99` → `1999`, `150` → `15000`; bunlar yalnızca dönüşüm örneğidir, uygulamaya örnek ürün/fiyat eklenmez.

Katalog güncellemesi yalnızca `products` değiştirir. Mevcut satış API'si ürün adını, liste fiyatını ve gerçekleşen fiyatı `sale_items` içine snapshot olarak yazar; eski satışlar güncel katalogdan hesaplanmaz. Kullanılmış ürünler silinemez; pasife alınabilir. Bu ürün değişikliği satış veya tahsilat kayıtlarını değiştirmez.

## Silme ve satış satırı düzenlemesi: kontrol / yayın

Bu ek geliştirmede yeni test yazılmadı; test, build, deploy veya D1 işlemi çalıştırılmadı. Web/API kaynak TypeScript ve değişen kaynak dosyalarının lint kontrolleri çalıştırıldı. Önceki modülün aşağıdaki test sonuçları bu değişikliğin test edildiği anlamına gelmez. Satış formunda özel fiyat/sıfırlama fiyat alanının altındadır; masaüstü beş sütun, mobil ürün başlığı + yan yana fiyat/miktar + toplam/kaldır düzenidir. Para ayrıştırma ve satış gönderim mantığı korunur; tarayıcı görünümü bu görevde doğrulanmadı.

Bu geliştirme yeni migration gerektirmez. Üretimde önceki özel fiyatlandırma `0003` migration'ı eksikse önce [SALES.md](SALES.md#özel-fiyatlandırmayı-devreye-alma) sırasını tamamlayın; uygulanmış migration'ı elle tekrarlamayın. Sonrasında önce `akcat-api` içinde `npm.cmd run deploy`, ardından `akcat-app` içinde `npm.cmd run deploy` çalıştırılır. Web deploy script'i kendi build'ini içerir. Komutlar operatör içindir; bu görevde çalıştırılmadı.

## Kontroller

API: `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run build` (yalnızca dry-run). Testler gerçek Workers runtime’ını, farklı test DB kimliğini ve geçici OS dizinini kullanır. Şema, kullanıcı/ürün fixture’ları, audit hata trigger’ı ve tarihsel snapshot kayıtları yalnızca izole DB’dedir; gerçek yerel/uzak D1’e yazılmaz. Test Worker’ı üretim entrypoint’ine dahil değildir.

API’de bağımsız lint script’i yoktur; web’in mevcut ESLint’i ile `..\akcat-app\node_modules\.bin\eslint.cmd --config ..\akcat-app\eslint.config.js src tests\worker.ts` kullanılabilir. React fiyat/tarayıcı testleri [web README](../../akcat-app/README.md) içinde açıklanır. Yerel testler Cloudflare edge/üretim kapasitesini doğrulamaz.

## Bu modülün dosyaları ve doğrulaması

| Alan | Eklenen / güncellenen dosyalar |
|---|---|
| API | `src/products/schemas.ts`, `repository.ts`, `endpoints.ts`; `src/index.ts`; `tests/auth.test.mjs`, `tests/worker.ts`; `docs/PRODUCTS.md`, `README.md` |
| Web ürün | `src/products/ProductsPage.tsx`, `ProductListPage.tsx`, `ProductForm.tsx`, `routing.ts`, `products.css`; `src/services/products.ts` |
| Web entegrasyon | `src/App.tsx`, `src/layout/navigation.ts`, `src/pages/modulePages.ts`, `src/services/apiClient.ts`, `src/utils/format.ts`, `package.json`, `README.md` |
| Ortak yükleme | `src/customers/useResource.ts` → `src/hooks/useResource.ts`; müşteri liste/detay import’ları güncellendi, davranış değişmedi |
| Web testleri | `tests/format.test.mjs`, `tests/products.browser.mjs`, `tests/run-auth.mjs` |
| Kök dokümanlar | `PROJE.md`, `MIMARI_TASARIM.md` |

Doğrulanan sonuçlar: 48 API testi (23 auth, 13 müşteri, 12 ürün), 3 fiyat birim testi; 13 auth, 10 müşteri ve 9 ürün tarayıcı kontrolü. Web/API TypeScript ve build; API kaynak lint’i başarılı. Web lint’i hata vermedi; üretilmiş `worker-configuration.d.ts` dosyasında mevcut iki gereksiz eslint-disable uyarısı var. Ürün form/liste görünümü 320, 390 ve 1440 px’de kontrol edildi; yatay taşma yok. Şema, Worker binding’leri, bağımlılıklar ve gerçek veriler değişmedi. Deploy/commit/push yapılmadı.
