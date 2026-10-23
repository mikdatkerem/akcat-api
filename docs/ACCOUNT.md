# AKÇAT — Hesabım ve parola değiştirme

Admin ve employee `#/hesabim` ekranından kendi kullanıcı adını, rolünü ve hesap durumunu `GET /api/v1/auth/me` ile görüntüler. Masaüstü sidebar kullanıcı alanı ve mobil hamburger drawer aynı bağlantıyı sunar; sidebar/drawer mimarisi korunur. Hesap bilgisi alınamazsa gerçek hata/yeniden deneme gösterilir; sabit kullanıcı veya sahte veri yoktur.

## Sözleşme ve güvenlik

`POST /api/v1/auth/change-password` JSON gövdesi yalnızca `{current_password,new_password}` kabul eder. Parola tekrarı istemci doğrulamasıdır. Kullanıcı ID'si istemciden alınmaz; admin dahil yalnızca kendi oturumundaki kullanıcı değiştirilir. Başka hesap için mevcut admin `/api/v1/users/:id/reset-password` yolu kullanılır.

Yeni parola mevcut kullanıcı yönetiminin ortak politikasına uyar: 15–128 karakter, kenar boşlukları hariç en az 15 karakter; mevcut paroladan farklı. Scrypt parametreleri değiştirilmedi. Mevcut parola yanlışsa `400 CURRENT_PASSWORD_INVALID`; zayıf/bilinmeyen alan `400 INVALID_PASSWORD_INPUT`; aynı parola `400 PASSWORD_UNCHANGED`. Oturum geçersizse 401, Origin/CSRF ihlalinde 403, eşzamanlı değişiklikte `409 PASSWORD_CHANGE_CONFLICT`, hesap başına çok denemede `429 PASSWORD_CHANGE_RATE_LIMITED` döner. Yanlış mevcut parola tek başına oturumu kapatmaz.

Mevcut account rate-limit binding'i ayrı `akcat:password-change:` anahtar alanında kullanıcı ID'si hash'ine göre kullanılır (5 deneme/60 saniye); eksik/arızalı binding 503 verir. Login sayaçları değişmez; mevcut limiter'ın bölgesel yaklaşımı küresel kilit olarak varsayılmaz. Exact Origin, CSRF, JSON ve 4 KiB sınırı korunur. [AUTH.md](AUTH.md) taşıma/cookie/ortam kurallarının kaynağıdır.

Parola doğrulama ve yeni scrypt hesaplamasından sonra, primary D1 atomik batch'i doğrulanan eski hash'i, aktifliği ve geçerli oturumu yeniden kontrol eder. Koşullu tek audit işaretiyle parola/updated_at yazılır ve bu kullanıcının tüm iptal edilmemiş cookie/bearer oturumları kapatılır. Herhangi bir SQL hatasında audit dahil her şey geri alınır. Eski doğrulamayı kullanan ikinci istek veya admin reseti/logout/pasifleştirmeyle yarışan istek bu kontrolü aşamaz. Login'in hash koşullu session INSERT'i eski parola doğrulamasından geçerli oturum üretilmesini engeller.

Başarı yanıtı `200 {success:true}`; cookie istemcisinde mevcut cookie silinir. `auth.password_changed` audit'i actor, hedef kullanıcı, eylem ve UTC zamanı içerir; metadata NULL'dır. Parola, hash, hızlı parola özeti ve token log/audit'e yazılmaz.

## Web davranışı

Ortak Input/Button/Card/Badge ve tasarım tokenları korunur. Her parola alanında göster/gizle ve uygun autocomplete bulunur; alan doğrulaması ilk hataya odaklanır. Ref tabanlı eşzamanlı gönderim kilidi ve disabled/loading çift gönderimi engeller. Yeni parola tekrarı API'ye gönderilmez. Parola/token Web Storage'a yazılmaz.

Onaylı başarıda parola alanları ve bellekteki oturum/CSRF temizlenir; giriş ekranında tüm oturumların kapandığı açıklanır. Yeni girişten sonra mevcut `#/hesabim` adresine dönülür. Sayfa terk edildiğinde form belleği kaybolur. Yanıt kaybolduğunda değişiklik olmuş olabilir; başarı/çıkış varsayılmaz, form kilitlenir ve açık `/me` kontrolü sunulur. Oturum devam ediyorsa temiz form açılır, gerçek 401 varsa giriş gerekir. Otomatik parola değiştirme tekrarı veya kurtarma yapılmaz.

## Doğrulama

- `tests/account.test.mjs`: her iki rol, gerçek `/me`, doğru/yanlış mevcut parola, zayıf/aynı parola, hedef kullanıcı enjeksiyonu ve admin reset yetkisi, eski/yeni login, bütün oturumlar, audit sır sızıntısı, CSRF/Origin/JSON/boyut/rate limit, eşzamanlı değişiklik/admin reset ve D1 rollback.
- `akcat-app/tests/account.browser.mjs`: gerçek React → Vite proxy → Workers → izole D1; korumalı hesap, doğrulama/hata, ağ hatası, çift gönderim, cookie/oturum kapanışı, başarı mesajı/yeni giriş, her iki rol ve drawer bağlantısı, commit sonrası kayıp yanıt. Üretim API yanıtları mock edilmez; ağ kesintisi tarayıcı taşımasında uygulanır.
- API `npm.cmd test`; webde yeni geçici `npm.cmd run test:auth:serve` ortamında `npm.cmd run test:account:browser -- --metadata <browser.json> --playwright-dir <kurulu-runtime>`; ayrıca mevcut auth ve users regresyonları. Ortamlar iş bitiminde Enter ile kapatılıp temizlenir.

Yeni migration, paket/binding, gerçek hesap veya gerçek D1 yazması yoktur. Gerçek Cloudflare edge CPU/TLS ve gerçek hesaplarla kullanım yerel testlerin kapsamı değildir. Yeni görsel tasarım değerlendirmesi yapılmaz; mevcut tasarım korunur. MFA, e-posta/parola kurtarma veya mobil uygulama eklenmedi.

23 Ekim 2026 son kontrol sonucu: **171/171 API testi** (161 mevcut regresyon + 10 yeni hesap güvenliği testi), **13/13 web birim testi**, **26/26 tarayıcı kontrol grubu** (6 Hesabım, 13 authentication, 7 kullanıcı yönetimi) başarılı. Web/API TypeScript ve kaynak lint başarılı; web lint'inde üretilmiş `worker-configuration.d.ts` dosyasındaki mevcut iki unused-disable uyarısı var. Web build ve API `wrangler deploy --dry-run` başarılı; deploy yapılmadı. İlk regresyon koşumundaki `/me` sözleşme beklentisi yeni `is_active:true` alanına güncellendi; son tam koşum hatasız. Yeni drawer testi React kapanışını bekleyecek şekilde düzeltildi. Üretim güvenliği gevşetilmedi.

## Değişen kaynaklar

API: `src/auth/changePassword.ts`, `auth/{schemas,endpoints}.ts`, `users/schemas.ts` (ortak politika), `src/index.ts`, `tests/{account,auth}.test.mjs`, `package.json` ve ilgili belgeler.

Web: `src/account/{AccountPage.tsx,account.css}`, `services/{auth,apiClient}.ts`, `auth/{sessionStore.ts,LoginPage.tsx}`, `layout/{AccountActions,AppLayout}.tsx`, `layout/navigation.ts`, `App.tsx`, `tests/{account.browser,run-auth}.mjs`, `package.json` ve README. Kök proje/mimari/tasarım belgelerine ilgili özellik eklendi.
