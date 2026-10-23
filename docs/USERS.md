# Çalışan ve kullanıcı hesabı yönetimi

Yalnızca `admin` erişir. Mevcut Hono/Chanfana, cookie oturumu, exact Origin/CSRF, scrypt ve D1 primary kullanılır. Halka açık kayıt veya kurtarma endpoint'i eklenmedi. İlk admin mevcut operatör bootstrap'ıyla kurulur; sonraki hesaplar bu modülle oluşturulur. Mevcut `users`, `sessions`, `audit_logs` yeterlidir; migration/binding/yeni paket yoktur.

## API sözleşmesi

| Endpoint | İstek | Yanıt |
|---|---|---|
| `GET /api/v1/users` | `q`, `status=all/active/inactive`, `page`, `pageSize` | `{data:ManagedUser[],pagination}` |
| `POST /api/v1/users` | `{username,password,role?}` | İlkinde `201 {data:ManagedUser}`, aynı işlemin tekrarında `200` |
| `GET /api/v1/users/:id` | UUID | `200 {data:ManagedUser}` |
| `PATCH /api/v1/users/:id` | `{username?,role?,is_active?}`; en az bir alan | `200 {data:ManagedUser}` |
| `POST /api/v1/users/:id/reset-password` | `{password}` | `200 {data:ManagedUser}`; bütün mevcut oturumlar iptal edilir |

**Bütün yazmalarda** UUID `Idempotency-Key`, JSON ve cookie istemcisinde izinli Origin/oturuma bağlı `X-CSRF-Token` zorunludur. Gövde sınırı 4 KiB. Bilinmeyen yazma alanları reddedilir. `ManagedUser`: yalnızca `id,username,role,is_active,created_at,updated_at`; parola/hash/oturum tokenı yoktur. `is_active` JSON boolean; tarihler UTC ISO.

Kullanıcı adı login ile aynı NFKC → kırpma → Türkçe küçük harf normalleştirmesini kullanır; 3–64 harf/rakam veya `. _ -`, ham girdi en fazla 128 karakter. Parola 15–128 karakter, dış boşluklar hariç en az 15 karakterdir; parola değiştirilmeden scrypt'e verilir. Benzersiz uzun parola/parola yöneticisi kullanılmalıdır. Yeni hesap aktif, varsayılan rol `employee`; yalnızca `admin` veya `employee` kabul edilir. Kullanıcı adı normalize edilmiş değerle UNIQUE'dir.

Liste varsayılan 1/20, sayfa en çok 100000 ve boyut en çok 100'dür. Literal Türkçe kullanıcı adı araması en fazla 100 karakter; sıralama oluşturulma/ID azalan. Sayım ve kayıtlar aynı session batch'inde okunur. Boş arama sonucu gerçek `data:[]` ve sıfır sayımdır.

## Yetki, audit ve eşzamanlılık

Middleware her istekte güncel rol/aktifliği okur; employee, tüm beş endpoint'te doğrulamadan önce 403 alır. Yazma batch'i ayrıca işlemi yapan kullanıcının **hâlâ aktif admin** ve ilgili oturumun **hâlâ geçerli/iptal edilmemiş** olduğunu doğrular. Hash hesaplaması sürerken yetkisi veya oturumu alınan admin bu kontrolü aşamaz.

Admin kendisini pasife alamaz veya employee yapamaz. Hedef son aktif adminse rol düşürme/pasifleştirme aynı transaction içindeki güncel aktif admin sayımıyla engellenir. İki adminin eşzamanlı birbirini değiştirmesi en az bir aktif admin bırakır. UI kontrolleri tek başına güvenlik değildir.

Audit ve yazma bir D1 `batch` içindedir: `user.created`, `user.updated`, `user.password_reset`. Rol/aktiflik/kullanıcı adı değişiminde önce/sonra ve actor/target/zaman korunur; parola sıfırlamada yalnızca alan adı ve işlem izi tutulur. Parola, parola hash'i veya hızlı parola digest'i audit'e yazılmaz. Audit hatasında kullanıcı/oturum değişikliği bütünüyle geri alınır. Parametreli SQL ve sabit sorgu parçaları kullanılır. [D1 atomik batch davranışı](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

Pasifleştirme tüm mevcut oturumları atomik olarak iptal eder; yeniden aktifleştirme eski oturumları canlandırmaz. Rol değişikliğinde oturum iptal edilmez; mevcut middleware güncel rolü **sonraki API isteğinde** uygular. Kullanıcı adı değişikliği ID'yi veya geçmiş FK ilişkilerini değiştirmez. Eski ekranlardaki actor etiketi mevcut kullanıcı adını gösterebilir; finansal kayıtlar yeniden yazılmaz. Fiziksel silme endpoint'i yoktur.

## Tekrar güvenliği ve parola sıfırlama

Mevcut audit PK'si actor + UUID kapsamındaki işlemi tekilleştirir. Create aynı kullanıcı adı/rol ve parola için aynı hesaba döner. Parola karşılaştırması mevcut güçlü scrypt doğrulamasıyla yapılır; çevrimdışı hızlı tahmine yol açacak SHA parola özeti saklanmaz. Farklı içerik aynı anahtarla 409 verir. Farklı anahtarla aynı kullanıcı adı da 409'dur.

PATCH ve reset tekrarlarında yazma/oturum iptali yeniden uygulanmaz; güncel güvenli hesap bilgisi döner. Eski bir pasifleştirme anahtarıyla tekrar, sonradan aktifleştirilen hesabı tekrar kapatmaz. Reset tekrarında parola hâlâ aynıysa başarı döner ve sonradan açılmış oturumlar korunur. Başka reset sonrasında eski anahtar/parolayla tekrar 409 verir; eski parola geri yüklenmez.

Parola reset ve tüm mevcut oturumların iptali aynı transaction'dadır. Login'in mevcut `password_hash` koşullu oturum INSERT'i eski parola doğrulamasıyla yarışan reseti güvenli karşılar: login önce commit ederse reset oturumu iptal eder, reset önce commit ederse eski hash'le oturum oluşturulamaz. Kendi parolasını sıfırlayan adminin mevcut oturumu da biter; web `/auth/me` ile durumu doğrular ve giriş ekranına döner.

## Web ve işletim sınırları

`#/calisanlar`, `/yeni`, `/:id`, `/:id/duzenle`, `/:id/parola`. Menü yalnızca admin'e görünür; doğrudan hash de rol korumasından geçer. Mobilde liste kartları, masaüstünde tablo; mevcut sidebar/hamburger/drawer ve tasarım tokenları korunur. Rol/durum değişimi, admin hesap oluşturma ve parola sıfırlama onay dialog'u ister. Boş, yükleniyor, hata ve başarı durumları gerçek API'ye bağlıdır.

Parola sadece oluşturma/reset formunda maskeli ve bellekte tutulur; listede/detayda veya Web Storage'da saklanmaz. Belirsiz yanıtta aynı body/anahtar korunur; alanlar kilitlenir ve otomatik mutation retry yapılmaz. Başarıda parola alanları temizlenir. Sayfayı tam yenileme/terk etme form taslağını kaybettirir: create için benzersiz kullanıcı adı ikinci hesabı engeller; reset sonrasında yeni işlem başlatmadan kullanıcı/audit durumu uzlaştırılmalıdır. Reset sırasında bilerek yeni anahtar kullanmak yeni bir reset kararıdır.

Gerçek hesap bu geliştirmede kurulmadı; başlangıç parolasını yalnızca yetkili admin belirleyip güvenli kanaldan iletir. Admin ve employee artık [Hesabım](ACCOUNT.md) üzerinden mevcut parolalarını doğrulayarak kendi parolalarını değiştirebilir; tüm oturumları kapatılır. Bu self-service endpoint kullanıcı/rol yönetimi veya başka hesabı sıfırlama yetkisi vermez. E-posta/SMS gönderme, otomatik geçici parola, ilk girişte zorunlu parola değişimi, MFA ve self-service kurtarma yoktur. Tek admin parolasını kaybederse bu API'yi kullanamaz; kimliği doğrulanmış operatör kurtarma prosedürü ayrıca gerekir. Üretim scrypt CPU/bellek/staging koşulları [AUTH.md](AUTH.md) ve [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md) içinde geçerlidir.

## Kontroller ve dosyalar

`tests/users.test.mjs`: auth/rol, normalleştirme, hash, unique/idempotency, giriş, pasifleştirme/yeniden aktifleştirme, rol, self/son admin, reset ve eski parola/oturum, yeni oturumu koruyan tekrar, paralel yönetim, audit rollback ve finansal/FK geçmişi. `tests/users.browser.mjs`: gerçek React/proxy/API ile ekranlar, onaylar, kayıp yanıt tekrarları, gizli alanlar, API hatası ve 320/390/1440 px. Testler yalnızca ayrı kimlikli geçici D1 kullanır; mevcut yerel/uzak D1'e yazmaz. Tarayıcı runner'ı hata günlüklerindeki `fill(...)` değerlerini maskeler.

API: `src/users/{schemas,repository,endpoints}.ts`, `src/index.ts`, `tests/users.test.mjs`, `package.json`. Web: `src/services/users.ts`, `src/users/{UsersPage,UserForm,PasswordReset,UserDialog}.tsx`, `users.css`, `src/App.tsx`, `src/layout/navigation.ts`, `src/services/apiClient.ts`, `tests/users.browser.mjs`, `tests/run-auth.mjs`, `package.json`. İlgili kök dokümanlar, AUTH/README ve çıkış planı güncellenir. Migration, yeni bağımlılık, deploy, gerçek kullanıcı, seed, commit veya push yoktur.

23 Ekim 2026 kontrol sonucu: **161/161 API testi** (148 mevcut authentication/iş/finans/migration regresyonu + 13 hesap yönetimi testi), **13/13 web tutar/yapılandırma/yol tarifi birim testi**, **28/28 tarayıcı kontrolü** (7 çalışan, 13 auth, 8 tahsilat) başarılı. Web/API TypeScript, kaynak lint ve build başarılı; API build yalnızca dry-run'dır. Web'in üretilmiş tip dosyasındaki önceden bulunan iki lint uyarısı korunuyor. 320/390/1440 px form, liste ve kritik onay kontrolleri başarılı. Önceki tarayıcı koşumlarında bulunan locator seçimi sorunları test kodunda giderildi; güvenlik mekanizması kapatılmadı. Geçici test ortamları kapanınca temizlenir; gerçek Cloudflare edge CPU/TLS veya gerçek hesap kurulumu bu sonuçların kapsamı değildir.
