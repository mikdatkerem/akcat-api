# AKÇAT API — Kimlik doğrulama ve ilk admin

Bu altyapı bağımsız `akcat-api/` içindedir. React giriş/oturum istemcisi `akcat-app/` içindedir; mobil uygulama henüz geliştirilmedi. D1 şeması ve dokuz temel tablo korunur. Yeni migration gerekmez. Halka açık kayıt/kullanıcı oluşturma endpoint’i yoktur.

## Endpoint sözleşmesi

| Endpoint | Gereksinim | Yanıt |
|---|---|---|
| `POST /api/v1/auth/login` | İzin verilen `Origin`, `Content-Type: application/json`, `{username,password}` | Web cookie’si ve `{user:{id,username,role},expiresAt,csrfToken}` |
| `GET /api/v1/auth/me` | Geçerli oturum | Güncel kullanıcı, son kullanma ve web CSRF tokenı |
| `POST /api/v1/auth/logout` | Geçerli oturum; web’de izin verilen `Origin` ve `X-CSRF-Token` | `{success:true}`; oturum iptali ve cookie silme |

Yanıtlar `Cache-Control: no-store` taşır. Girişte bilinmeyen kullanıcı, yanlış parola ve pasif hesap aynı genel `401 INVALID_CREDENTIALS` yanıtını alır; hepsinde aynı KDF çalıştırılır. Geçersiz girdi `400`, oturum yok/geçersiz/süresi dolmuş/pasif hesap `401`, rol veya CSRF ihlali `403`, içerik tipi `415`, büyük gövde `413`, giriş sınırı `429`, eksik güvenlik yapılandırması `503` döndürür. Hatalarda SQL/stack/kimlik bilgisi gösterilmez. İstek gövdesi üst sınırı 4 KiB’dir. Kullanıcı adı NFKC + kırpma + Türkçe küçük harfle normalleştirilir (3–64 harf/rakam/`._-`); parola aynen korunur.

## Parola ve oturum güvenliği

- Workers `node:crypto` yerleşik Argon2id sunmuyor. Harici WASM paketi/bellek yükü eklemek yerine yerleşik scrypt seçildi: `N=16384, r=8, p=5`, 16 bayt rastgele salt, 32 bayt çıktı, 32 MiB KDF bellek üst sınırı (temel çalışma belleği yaklaşık 16 MiB). Bu, OWASP’ın eşdeğer minimum alternatiflerinden biridir. Parametreler hash içinde sürümlüdür; doğrulama keyfi iş yükü parametrelerini kabul etmez. Salt yalnızca `password_hash` içinde kalır, API’ye çıkmaz. Karşılaştırma sabit uzunlukta `timingSafeEqual` kullanır.
- Web oturumu `w1_` önekli 32 rastgele bayttır. D1 `sessions.id` ham tokenın SHA-256 hash’idir; ham token veritabanına/audit’e/yanıt gövdesine yazılmaz. Süre 8 saat, sabittir; otomatik uzatma yoktur. Logout `revoked_at` yazar, geçmiş silinmez. Her login yeni token üretir.
- `authenticate`, oturum + kullanıcıyı D1 primary üzerinden her istekte okur. Rol/aktiflik cookie içinden veya eski oturum snapshot’ından alınmaz. `requireRole("admin")` ve `requireRole("admin", "employee")` tekrar kullanılabilir. Yeni iş rotalarında önce `authenticate`, sonra yazma için `requireCsrf`, ardından gerekli rol kontrolü bağlanmalıdır. Middleware varlığı yeni rotaları kendiliğinden korumaz.
- Login/logout ve ilk admin eylemleri audit’e yazılır; parola, ham token ve CSRF değeri yazılmaz. Bootstrap kilidi dahil audit geçmişi korunmalıdır. Süresi dolmuş oturumların bakım/retention politikası sonraki işletim işidir; bu çalışma kayıtları silmez.

Kaynaklar: [Workers crypto desteği](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/), [OWASP parola saklama](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

## Web cookie, CSRF ve mobil ayrımı

Üretim cookie’si `__Host-akcat_session; Path=/; HttpOnly; Secure; SameSite=Lax` biçimindedir; `Domain` tanımlanmaz. HTTPS zorunludur. React web entegrasyonu `credentials: "include"` kullanır; `login` veya `me` yanıtındaki CSRF değerini yalnızca bellekte tutup `X-CSRF-Token` başlığıyla yazma isteklerine ekler. Login sonrası cookie `/me` üzerinden doğrulanır; sayfa yenilemede yine `/me` kullanılır. localStorage/sessionStorage veya Bearer kullanılmaz. Ayrıntılar: [Web oturum entegrasyonu](../../akcat-app/README.md).

CSRF değeri ham web tokenı ile ayrı bir sabit bağlam üzerinden HMAC-SHA-256 olarak türetilir ve oturuma bağlıdır. Cookie ile yazmada hem tam origin eşleşmesi hem CSRF doğrulaması zorunludur. Login öncesinde oturum olmadığından login-CSRF koruması izinli `Origin` + yalnızca JSON gövdesidir; basit HTML form istekleri kabul edilmez. CORS yalnızca yapılandırılan origin’leri ve belirli metot/başlıkları açar, wildcard yoktur.

Yerelde `.dev.vars.example` dosyasını **var olan dosyayı ezmeden** `.dev.vars` olarak kopyalayın. `AUTH_INSECURE_LOCAL_COOKIE=true` yalnızca HTTP loopback URL’lerinde (`localhost`, `127.0.0.1`, `[::1]`) `akcat_session_dev` isimli Secure olmayan cookie’ye izin verir; diğer HTTP adresleri reddedilir. Web `localhost:5173` ve API `localhost:8787` olarak kullanılmalıdır. Mevcut Vite proxy korunur; proxy’nin hedefi değiştirmesi `Origin` değerini değiştirmez.

Gelecekteki mobil yol ayrı `m1_` tokenları ve `Authorization: Bearer` taşımasını kullanacak; aynı `sessions`, `authenticate` ve rol kuralları geçerli olacak. Bearer kabulü **varsayılan kapalıdır** (`AUTH_ENABLE_MOBILE_BEARER=false`); mobil token veren login/refresh endpoint’i henüz yoktur. Cookie + Bearer birlikte, web tokenı Bearer içinde, mobil tokenı cookie içinde ve çift cookie reddedilir. Mobil uygulama ve güvenli token verme/cihaz deposu tamamlanmadan bu bayrağı açmayın. Bearer için cookie-CSRF şartı uygulanmaz; origin varsa yine allowlist’e tabidir.

## İlk admin — açık operatör eylemi

Bu aşamada gerçek admin oluşturulmadı. Komut, kullanıcı adı ve gizli parola istemi açar; parolayı argüman, ortam değişkeni, dosya veya SQL geçmişine yazmayın. Parola en az 15, en fazla 128 karakter olmalı; benzersiz ve parola yöneticisiyle üretilmiş bir değer kullanın. Kullanıcı oluşturma yalnızca bu kurulumla ilk admin için yapılır; çalışan yönetimi ayrı geliştirmedir.

Yerel kurulum için `akcat-api/` içinde:

```powershell
npm.cmd run bootstrap:admin -- --local
```

Etkileşimli terminal, mevcut yerel şema ve `.wrangler/state/v3` için yetkili dosya erişimi gerekir. Komut hedef D1 adını/kimliğini gösterir; onay için adı aynen yazın, kullanıcı adını ve görünmeyen parolayı iki kez girin. `remoteBindings:false` ile yalnızca mevcut yerel D1 kullanılır. Komut migration/seed/reset çalıştırmaz. Geliştirme sunucusu özel bir persistence yolu kullanıyorsa önce varsayılan yol ile tutarlılığı sağlayın; bu CLI varsayılan yolu kullanır.

Uzak kurulum için aynı komutun `--remote` biçimi hazırlanmıştır:

```powershell
npm.cmd run bootstrap:admin -- --remote
```

Önce işletim ortamının gizli bilgi yönetimi üzerinden `CLOUDFLARE_ACCOUNT_ID` ve ilgili hesaba D1 düzenleme (`D1 Write`) yetkili, mümkün olan en dar kapsamlı `CLOUDFLARE_API_TOKEN` sağlayın. Tokenı kaynak koda, komut geçmişine veya dokümana koymayın. Komut `wrangler.jsonc` içindeki `akcat-db` kimliğini kullanır, **UZAK / CANLI** hedefi gösterir ve adı tekrar yazdırır. Mevcut şema ayrıca doğrulanmış olmalıdır. Parola yerelde hash’lenir; Cloudflare D1 REST API’ye HTTPS üzerinden yalnızca hash ve parametreli sorguların tek batch’i gönderilir. Cloudflare kimlik doğrulaması olmayan uzak kurulum çalışmaz. İşlem sonrası operatör tokenını oturum ortamından kaldırın/iptal edin. **Uzak işlem bu çalışma sırasında çalıştırılmadı veya canlıda doğrulanmadı.**

Tek atomik batch, admin yoksa kullanıcıyı ve `audit_logs.id = system:first-admin-bootstrap` kilidini oluşturur. Mevcut admin veya kilit varsa reddeder; eşzamanlı kurulumda en fazla biri başarılı olur. İlk admin sonradan pasifleştirilse/employee olsa bile kilit kalır. Kilidi silerek tekrar kurulum yapılmamalıdır; kurtarma ayrı, kimliği doğrulanmış operatör prosedürüdür. Yedek geri dönüşlerinde bu işaret ve yetkiler de korunmalıdır. Ağ hatasında komutu körlemesine tekrarlamak yerine yetkili kişi kurulum durumunu doğrulamalıdır.

## Üretim öncesi koşullar ve sınırlar

1. `AUTH_ALLOWED_ORIGINS` değerini gerçek HTTPS web origin’i/origin’leriyle virgülle ayırarak ayarlayın; sondaki slash/path/wildcard kabul edilmez. Varsayılan boş değer auth’u `503` ile kapatır; health etkilenmez. Üretimde `AUTH_INSECURE_LOCAL_COOKIE=false`, `AUTH_ENABLE_MOBILE_BEARER=false` kalmalı. Web/API aynı origin veya aynı site altında HTTPS ile yayınlanmalıdır; farklı siteler arasında `SameSite=Lax` cookie gönderilmez. Geniş cookie/CORS açmak yerine yönlendirmeyi düzenleyin.
2. Cloudflare hesabında rate-limit namespace kimliklerinin başka uygulamalarla çakışmadığını doğrulayın; `AUTH_IP_RATE_LIMITER` 20/60 sn, `AUTH_ACCOUNT_RATE_LIMITER` 5/60 sn bağlanmalıdır. Hesap anahtarı normalize kullanıcı adı hash’i, IP anahtarı Cloudflare’ın `CF-Connecting-IP` hash’idir. Eksik/başarısız binding `503`; aşım `429 + Retry-After: 60` verir. `X-Forwarded-For` kullanılmaz. Lokal geliştirme internete açılmamalıdır.
3. Workers Rate Limiting konum bazlı ve yaklaşık/eventual consistency ile çalışır; kesin küresel hesap kilidi değildir. Dağıtık parola denemeleri için üretimde WAF/bot politikası ve gerekirse tutarlı küresel sayaç (ör. Durable Object) değerlendirilmelidir. Bu ek kaynaklar oluşturulmadı. Yerel testler binding entegrasyonunu doğrular; Cloudflare edge/WAF davranışını ölçmez.
4. Güçlü scrypt Free planın 10 ms CPU bütçesine uygun varsayılamaz. Paid plan/uygun CPU bütçesi ve gerçek edge CPU-bellek ölçümü üretim ön koşuludur. Yerel başarı üretim kapasite testi değildir; parametreler düşük bütçeye uydurmak için zayıflatılmamalıdır. Plan değiştirilmedi/deploy yapılmadı.
5. MFA, parola değiştirme/kurtarma, çalışan oluşturma, tüm cihazlardan çıkış ve idle timeout bu kapsamda yoktur. Açılmadan önce işletim ihtiyacına göre ayrı ele alınmalıdır. React login entegrasyonu hazırdır; gerçek ilk admin kurulumu ve üretim koşulları ayrıca operatör tarafından tamamlanmalıdır.

Kaynaklar: [Workers rate-limit kapsamı](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [Workers limitleri](https://developers.cloudflare.com/workers/platform/limits/), [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), [D1 REST parametreli batch](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/).

## Kontrol kapsamı

`npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run build`. Test harness’i yalnızca `tests/wrangler.jsonc` tarafından yüklenir; üretim entrypoint’i test rotalarını içermez. Test DB kimliği gerçek `akcat-db` kimliğinden farklıdır; `--local` ve OS geçici persistence yolu zorunludur. Rastgele test anahtarı ve kullanıcı bilgileri her çalıştırmada yeniden üretilir. Mevcut yerel/canlı veritabanına test verisi yazılmaz. API Secure-cookie testi yerel Worker’a mantıksal HTTPS isteği geçirerek HTTP başlıklarını doğrular; gerçek TLS/tarayıcı testi değildir. Web’in ayrı tarayıcı entegrasyon kontrolleri ve geçici test ortamı `akcat-app/tests/` içinde belgelenmiştir.
