# Müşteri yönetimi API sözleşmesi

Mevcut `customers` ve `audit_logs` tabloları kullanılır. Migration, yeni tablo veya fiziksel silme yoktur. Liste, detay, oluşturma ve temel düzenleme için `admin` / `employee`; `is_active` alanını PATCH ile göndermek için yalnızca `admin` gerekir (aynı değeri göndermek de employee için 403). Yeni müşteriler aktif oluşturulur. Yetki mevcut authentication/role middleware’iyle sunucuda doğrulanır.

| Metot / yol | İstek | Yanıt |
|---|---|---|
| `GET /api/v1/customers` | `q`, `status=all/active/inactive`, `page`, `pageSize` | `{data:Customer[],pagination:{page,pageSize,total,totalPages}}` |
| `POST /api/v1/customers` | JSON müşteri bilgileri ve UUID `Idempotency-Key` | `201 {data:Customer}`; aynı işlem tekrarı `200` |
| `GET /api/v1/customers/:id` | UUID müşteri ID | `200 {data:Customer}` |
| `PATCH /api/v1/customers/:id` | En az bir izinli JSON alanı | `200 {data:Customer}` |

`Customer` alanları: `id`, `name`, `phone`, `address`, `delivery_notes`, **boolean** `is_active`, UTC ISO `created_at` / `updated_at`. POST/PATCH body alanları aynı snake_case adlarını kullanır. `id`, tarihler veya bilinmeyen alanlar gönderilemez. `name`: zorunlu, kırpılmış 1–160 karakter; `address`: zorunlu, 1–1000; `phone`: isteğe bağlı/null, en fazla 64 karakter; `delivery_notes`: isteğe bağlı/null, en fazla 2000. PATCH’te gönderilmeyen alanlar korunur; boş/null telefon veya not alanı temizler. Kontrol karakterleri reddedilir; adres/notta normal satır sonları ve tab korunur. İstek gövdesi en fazla 16 KiB.

Telefon doğrulaması ülke kodu, uluslararası `00`, boşluk, nokta, parantez, tire ve isteğe bağlı `x`, `ext`, `dahili` (1–6 rakam) kabul eder. Ana numara 7–15 rakam olmalıdır; yalnızca Türkiye cep telefonu biçimi dayatılmaz. Kopyalanan uyumlu Unicode karakterleri/NBSP ve tireler normalleştirilir. Bir telefon rehberi/numara sahipliği doğrulaması yapılmaz.

Liste varsayılanı tüm durumlar, sayfa 1, sayfa boyutu 20’dir. Sayfa boyutu 1–100, sayfa 1–100000, arama en fazla 100 karakterdir. Aralık dışı/sayısal olmayan değerler 400; filtreyle hiç kayıt yoksa `data:[]`, `total:0`, `totalPages:0`; mevcut son sayfayı aşan sayfada boş data ve gerçek toplam döner. Sabit sıralama `created_at DESC, id DESC` kullanır. Sayım ve sayfa aynı D1 batch’inde okunur; farklı sayfa istekleri arasındaki eşzamanlı eklemeler snapshot garantisinde değildir.

Ad araması Türkçe büyük/küçük harf dönüşümlerini destekler; telefon araması biçim ayırıcılarını yok sayan rakam alt dizisini arar. SQL girdileri parametreye bağlanır, `%`, `_` ve SQL metni arama operatörü olmaz. Telefon araması ülke kodu/trunk dönüşümünü tahmin etmez. Mevcut şema korunur; büyük veri hacminde substring araması için indeks/arama stratejisi ayrıca değerlendirilebilir.

## Oturum, CSRF, CORS ve hata güvenliği

[AUTH.md](AUTH.md) cookie/Bearer ayrımı ve HTTPS/origin kuralları geçerlidir. Cookie ile POST/PATCH, geçerli oturum + tam izinli `Origin` + `X-CSRF-Token` ister. Yazmalar JSON’dur. Customer CORS sadece aynı allowlist üzerinde GET/POST/PATCH/OPTIONS ve gerekli başlıkları (`Idempotency-Key` dahil) açar. Auth endpoint’lerinin mevcut CORS metotları değişmemiştir. Yanıtlar `no-store` taşır; 401 oturum, 403 yetki/CSRF, 400 doğrulama, 404 müşteri bulunamadı, 409 işlem anahtarı çakışması, 413 boyut, 415 içerik tipi, 500 beklenmeyen hata anlamına gelir. Hatalar müşteri bilgisi, SQL veya stack döndürmez.

## Çift kayıt ve audit

İstemci yeni form açıldığında rastgele UUID işlem anahtarı üretir; aynı formdaki yeniden denemelerde değiştirmez. Sunucu ID’yi kendi `crypto.randomUUID()` çağrısıyla üretir. Müşteri + audit aynı atomik D1 batch’inde yazılır. Audit PK’si kullanıcı ve anahtarın hash’iyle adlandırılır; aynı anda iki kez gönderilirse yalnızca biri ekler. Aynı anahtar ve normalize body tekrarında aynı müşteri, farklı body’de 409 döner. Başka kullanıcı aynı anahtarı kendi işlem kapsamıyla kullanabilir.

Create audit metadata’sı yalnızca alan adları ve idempotency için gerekli request digest’i içerir. Update metadata’sında yalnızca değiştirilen alan adları tutulur. Müşteri adı, telefon, adres, not, parola, cookie veya CSRF değeri kopyalanmaz. `actor_user_id`, eylem (`customer.created` / `customer.updated`), entity ID ve UTC zaman saklanır. Audit yazılamazsa müşteri yazması geri alınır. Audit geçmişi/idempotency kayıtları silinmemelidir.

PATCH yalnızca gönderilen alanları değiştirir. Aynı alanın eşzamanlı düzenlenmesinde son yazma geçerlidir; bu aşamada ETag/sürüm çakışma arayüzü yoktur. Müşteri ID/finansal bağlar değişmez; pasife alma geçmiş satış/tahsilatları silmez veya yeniden hesaplamaz. Müşteri detayına toplam borç, açık satışlar ve tahsilat/finansal hareket geçmişi eklenmiştir; ayrı sözleşme: [FINANCE.md](FINANCE.md). Pasif müşterinin mevcut borcu tahsil edilebilir.

Kaynak: [D1 atomik batch ve prepared statements](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

## İzole kontroller

`npm.cmd run typecheck`, `npm.cmd run build`, `npm.cmd test`. Testler `tests/wrangler.jsonc` içindeki farklı DB kimliğini, `--local` ve OS geçici persistence dizinini kullanır. Şema ve fixture’lar sadece bu ortamda oluşturulur; mevcut yerel/canlı D1’e test verisi yazılmaz. Audit hata testi yalnızca test DB’de geçici trigger kullanır. `tests/worker.ts` hata enjeksiyonu/test kontrol rotaları üretim entrypoint’ine dahil değildir. İş bitiminde geçici ortam temizlenir.

API package.json’da bağımsız lint aracı/komutu yoktur. Bu görevde yeni paket eklemeden, web’de mevcut ESLint ile API kaynakları/test Worker’ı ayrıca denetlendi: API klasöründen `..\akcat-app\node_modules\.bin\eslint.cmd --config ..\akcat-app\eslint.config.js src tests\worker.ts`. Bu yalnızca yerel kontrol aracıdır; API’nin çalışma/build bağımlılığı değildir.

React/Chrome entegrasyonu ve 320/390/1440 px kontrolleri [web README](../../akcat-app/README.md) içinde açıklanır. Gerçek Cloudflare edge/üretim ortamı bu testlere dahil değildir.

## Değişen dosyalar

| Alan | Dosyalar |
|---|---|
| API — yeni | `src/customers/schemas.ts`, `repository.ts`, `endpoints.ts`; `docs/CUSTOMERS.md` |
| API — güncel | `src/index.ts`, `src/auth/middleware.ts`, `tests/auth.test.mjs`, `tests/worker.ts`, `README.md` |
| Web — yeni | `src/customers/CustomersPage.tsx`, `CustomerListPage.tsx`, `CustomerRecordPage.tsx`, `CustomerForm.tsx`, `routing.ts`, `useResource.ts`, `customers.css`; `src/services/customers.ts`; `src/components/ui/Textarea.tsx`; `tests/customers.browser.mjs` |
| Web — güncel | `src/App.tsx`, `src/layout/navigation.ts`, `src/services/apiClient.ts`, `src/components/ui/index.ts`, `src/pages/modulePages.ts`, `tests/run-auth.mjs`, `package.json`, `README.md` |
| Kök dokümanları | `PROJE.md`, `MIMARI_TASARIM.md` |

Şema/migration, lock dosyaları, Worker binding’leri ve bağımlılıklar değişmedi. Çalıştırılan son kontroller: web/API TypeScript ve build; API kaynak lint’i; web lint’i (üretilmiş tip dosyasında önceden bulunan iki uyarı); 36 API testi; 13 mevcut auth tarayıcı kontrolü ve 10 müşteri tarayıcı kontrolü. Fixture/ekran görüntüleri kullanılan geçici test ortamlarıyla birlikte temizlendi. Gerçek yerel/uzak D1 iş verisi üzerinde yazma/silme yapılmadı.
