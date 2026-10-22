# Üretime çıkış ve kurtarma planı

Bu belge **manuel operatör planıdır**. Bu denetimde deploy, uzak migration, uzak kullanıcı oluşturma, export/import/restore veya gerçek finansal yazma yapılmadı. Güncel bulgular: [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md).

## 1. Çıkış kapıları

- [ ] `0001` ve `0002` sürümleri hedef D1’de uygulanmış, migration takibi ve foreign key kontrolü doğrulanmış.
- [ ] Gerçek web/API adresleri ve DNS/HTTPS sahipliği kesinleştirilmiş.
- [ ] Paid plan / CPU bütçesi ve ayrı staging’de gerçek edge ölçümü onaylanmış.
- [ ] Yedek erişimi, Time Travel bookmark/retention ve staging kurtarma provası doğrulanmış.
- [ ] Güvenli ilk admin, kişiye özel employee hesapları ve hesap kurtarma/iptal prosedürü hazır.
- [ ] Bütün yerel testler, build/lint/typecheck ve sürümlenmiş dağıtım paketi hazır. Untracked dosya veya migration unutulmamış; commit/push bu görevin kapsamında yapılmaz.

Herhangi biri eksikse gerçek işletme trafiği açılmaz. Sağlık kontrolünün `ok` olması tek başına bu kapıları karşılamaz.

## 2. Adresleme ve ortamlar

Tercih: sahibinin belirlediği aynı site altındaki iki HTTPS adresi: web `https://app.<işletme-alanı>`, API `https://api.<işletme-alanı>`. Bunlar **yer tutucudur**, gerçek adres atanmadı. `VITE_API_BASE_URL` yalnızca gerçek API origin’ini içerir; `/api`, path, query, kimlik bilgisi eklenmez. Artık üretim build’i HTTP/loopback origin’ini reddeder. Build sırasında verilen adresi build sonrasında Worker `vars` değişikliği değiştirmez; web yeniden build edilmelidir.

Alternatif: `VITE_API_BASE_URL` boş, `/api/*` aynı origin üzerinde bağımsız API Worker’ına açık bir üretim yönlendirmesiyle bağlanır. Yönlendirme ayrıca kurulup doğrulanmalıdır. Web Worker’ı bu işi yapmaz; kendisine gelen API isteğine 404 verir. Vite `API_PROXY_TARGET` yalnızca yerel `vite dev` içindir, preview/üretim proxy’si değildir. API başka framework’e taşınmaz veya web ile birleştirilmez.

Staging için ayrı Worker adları, D1 kimliği, rate-limit namespace’leri, HTTPS origin’leri ve operatör izinleri gerekir. Üretim D1 binding’i staging’e bağlanmaz. Şimdiki test kimlikleri yalnızca yerel testler içindir; Cloudflare staging kaynağı oluşturulmadı.

## 3. Cloudflare ayarları ve sırlar

| Ayar | Üretim gereksinimi |
|---|---|
| API `DB` | Doğru hedef `akcat-db` kimliği, sürüm kontrolü yapılmış şema |
| `AUTH_ALLOWED_ORIGINS` | Gerçek HTTPS web origin’i; tam eşleşme, path/son slash/wildcard yok |
| `AUTH_INSECURE_LOCAL_COOKIE` | `false` |
| `AUTH_ENABLE_MOBILE_BEARER` | `false`; native mobil token verme akışı henüz yok |
| `AUTH_IP_RATE_LIMITER` | 20/60 sn, hesapta başka uygulamayla çakışmayan namespace |
| `AUTH_ACCOUNT_RATE_LIMITER` | 5/60 sn, ayrı namespace |
| CPU bütçesi | Güçlü scrypt korunarak staging ölçümüne ve Paid plana göre açık karar |
| Web `VITE_API_BASE_URL` | Boş + gerçek route veya aynı site altındaki gerçek HTTPS API origin’i |

Uygulamada sabit bir oturum imzalama sırrı yoktur: 256 bit rastgele opak oturum tokenı, D1’de SHA-256 hash’i ve tokena bağlı CSRF kullanılır. Sır icat edip `VITE_*` içine eklemeyin. `CLOUDFLARE_ACCOUNT_ID` ve dar kapsamlı Cloudflare API tokenı yalnızca yetkili operatörün gizli bilgi ortamında tutulur; tarayıcı bundle’ına, Git’e, shell geçmişine veya `.env.example` içine yazılmaz. Operatörün D1 Write yetkisi yalnızca gerekli hesap/hedef üzerinde ve gerekli süreyle açık olmalıdır. Yerel `.dev.vars` üretime kopyalanmaz.

Workers Rate Limiting konum bazlı ve yaklaşık çalışır; küresel sert kilit değildir. WAF/bot politikası ve dağıtık saldırı izlemesi ayrıca yapılandırılır; güvenlik uğruna kullanılan hash parametreleri düşürülmez. [Cloudflare rate-limit kapsamı](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

## 4. Migration öncesi yedek ve şema kontrolü

22 Ekim 2026 salt okunur gözlem: hedefte `d1_migrations` yalnızca `0001_initial_schema.sql` içeriyordu; `financial_adjustments` yoktu. Aktif admin ve bootstrap kilidi yoktu. Bu gözlemler daha sonra değişebilir; operatör işlemden hemen önce tekrar kontrol eder.

1. Hedef ad/UUID/hesap eşleşmesini iki kişi veya operatör kontrol listesiyle doğrulayın. İşlem penceresinde finansal yazmaları durdurun; kullanıcılardaki belirsiz işlemleri uzlaştırın.
2. `d1 info` ve `time-travel info` ile backend/geri dönüş erişimini, güncel UTC zamanı ve bookmark’ı güvenli değişiklik kaydında saklayın. Bu denetimde Time Travel info erişimi doğrulandı; restore yapılmadı.
3. Planın retention’ını doğrulayın: Free 7 gün, Paid 30 gün. Time Travel otomatik açıktır; eski alpha backend farklıdır. [Güncel D1 limitleri](https://developers.cloudflare.com/d1/platform/limits/), [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).
4. Operatör yetkisiyle gerekirse D1 SQL export alın; çıktı kişisel/finansal veri ve parola hash’i içerir. Şifreli, erişimi kısıtlı ve repo dışında bir yedek alanına kaydedin; checksum, tarih, hedef ve saklama süresini kaydedin. Bu görevde üretim export’u alınmadı.
5. Yedeği **ayrı staging D1’e** geri yükleyip foreign key kontrolü, satış/kalem toplamları, geçerli ödemeler, reversal ilişkileri, borç/ledger/rapor eşitliği ve bootstrap kilidini doğrulayın. Rastgele üretim kopyasını herkese açık staging’e bağlamayın. Staging Time Travel geri alma provası ayrıca yapılmalıdır; yerel migration testi bunun yerine geçmez.

## 5. Şema sırası ve tekrar davranışı

Yetkili operatör önce 0001, sonra 0002 uygular. Mevcut hedefte 0001 zaten izlenmektedir, yeniden CREATE SQL’i çalıştırılmaz. İnceleme sonrası standart migration takibini kullanın:

```powershell
# MANUEL, bu görevde UZAK ortamda çalıştırılmadı:
npm.cmd exec -- wrangler d1 migrations apply akcat-db --remote
```

Bu komut bekleyen migration’ları uygular; kullanmadan önce hedef ve yedek kontrol edilmelidir. Tracker üzerinden tekrarı yerelde no-op olarak doğrulandı. Ham `0002` SQL’ini ikinci kez çalıştırmak tablo zaten var hatası verir ve mevcut veri korunur; SQL dosyası `IF NOT EXISTS` ile şema uyumsuzluğunu gizlemez. [Migration takibi](https://developers.cloudflare.com/d1/reference/migrations/).

Sonrasında `d1_migrations` adları, `financial_adjustments` tablo/indeksleri ve `PRAGMA foreign_key_check` kontrol edilir. Eski ödemelere varsayılan iade türü atamayın. Eski ters kayıtlar tip/belge/tutar/yöntem/müşteri/satış bakımından incelenmeden ödemeli iptali açmayın. Negatif ödeme, yeni demo/seed veya geçmişi değiştiren backfill çalıştırmayın. Şema tamamlanmadan yeni API sürümü işletme kullanımına açılmaz.

## 6. İlk admin ve kişiye özel çalışanlar

İlk admin mevcut [AUTH.md](AUTH.md) güvenli TTY bootstrap yöntemiyle, hedef adı onayı ve gizli parola istemiyle **yetkili operatör** tarafından kurulur. Komut `npm.cmd run bootstrap:admin -- --remote` olup bu görevde çalıştırılmadı. Parola 15–128 karakter, benzersiz ve parola yöneticisinde saklanır; argüman, SQL metni veya ortam değişkeni olarak verilmez. Mevcut admin/kurulum kilidi varsa bootstrap tekrarlanmaz; `system:first-admin-bootstrap` silinmez. Ağ hatasında otomatik tekrar yerine durum doğrulanır.

Employee oluşturma, parola değiştirme/kurtarma ve tüm cihazlardan çıkış üründe henüz yoktur. 3–4 kişilik kullanım için ayrı yetkilendirilmiş bir çalışma kapsamında güvenli, audit’li hesap sağlama/iptal yöntemi tamamlanmalı ve test edilmelidir. Ortak admin hesabını çalışanlarla paylaşmak çözüm değildir. Admin kilitlenirse kimliği doğrulanmış operatör kurtarma prosedürü ve tüm mevcut oturumların iptal edilmesi ayrıca gerekir.

## 7. Gerçek edge staging ölçüm planı

Bu plan kaynak oluşturmaz veya deploy etmez; ileride açık staging yetkisiyle uygulanır. Ayrı staging’de aşağıdakiler ölçülmeden üretim kapısı kapanmaz:

- Geçerli giriş, yanlış parola, olmayan/pasif kullanıcı için eş KDF yolu; soğuk/sıcak örnekler. Rate limit’i kapatmayın; denemeleri normal sınırlar içinde farklı fixture hesapları/zaman pencereleriyle yürütün.
- Önce tek kullanıcı, sonra dört eşzamanlı giriş ve üç–dört normal iş kullanıcısı. CPU time ile ağ dahil wall time’ı ayrı kaydedin. Workers Logs/Analytics’te CPU p50/p95, 1102/`exceededCpu`/`exceededMemory`, startup ve hata oranlarını gözleyin; profil ile isolate bellek payını inceleyin. Token/parola/CSRF loglamayın.
- Scrypt `N=16384,r=8,p=5,maxmem=32MiB` aynen kalır. Free HTTP CPU sınırı 10 ms; Paid varsayılan 30 s ve ayarlanabilir üst sınır 300 s; isolate belleği 128 MiB ve eşzamanlı isteklerce paylaşılır. Yerel KDF zamanı edge CPU sonucu değildir. [Workers limitleri](https://developers.cloudflare.com/workers/platform/limits/).
- Gerçek HTTPS tarayıcıda `__Host-`/HttpOnly/Secure/SameSite=Lax cookie, `credentials:include`, origin/CSRF, preflight, logout, sona erme ve pasif kullanıcı/rol değişikliği doğrulanır. Yerel mantıksal HTTPS testi gerçek TLS kanıtı değildir.
- Staging D1 üzerinde bir aylık ve en az bir yıllık veri büyüklüğüyle sınırlı listeler, D1 `rows_read`/süre ve tarih indeksleri ölçülür. Yerel 2.000 satış probu edge veya yıllık kapasite taahhüdü değildir.
- Çıkış kabulü: beklenen giriş yoğunluğunda kaynak aşımı yok, seçilen CPU bütçesinde ölçüme dayalı pay var, finansal yazma atomik/idempotent, endpoint’ler/oturum güvenliği doğru. Sorunda hash’i zayıflatmayın; uygun Paid bütçesi, saldırı azaltma ve gerekiyorsa ayrı tasarım incelemesi yapın.

## 8. Deploy öncesi son kontrol

Kaynaklar/migration’lar birlikte inceleme ve sürüm kaydına alınır. `npm ci` yeniden üretilebilir kurulum yöntemi olarak operatörün temiz ortamında uygulanır; bu denetim paket kurmadı. API `test`, `typecheck`, `build` (dry-run); web tutar/config/tarayıcı testleri, TypeScript, lint/build tekrar doğrulanır. Üretim build’inde loopback adresi, sır veya fixture olmamalıdır. `/__test/*`, bootstrap ve örnek Task rotaları üretim bundle’ında API olarak sunulmamalıdır. Gerçek origin, minimum yetki ve log erişim/saklama politikası gözden geçirilir. GitHub dağıtım otomasyonu bu kapsamda kurulmaz.

## 9. Deploy sonrası kontrol planı

Yetkili dağıtımdan sonra önce `/api/health`, ardından authenticated `/auth/me` ve gerçek boş/dolu salt okunur raporlar doğrulanır. Health yalnızca `SELECT 1` yapar; migration veya finansal bütünlük kanıtı değildir. Gerçek origin/TLS/cookie/CSRF ve admin/employee sınırları tekrar kontrol edilir. Üretime test satışı veya sahte tahsilat eklemeyin. İlk **gerçek ve yetkili** işletme işlemlerini mevcut satış snapshot’ı, ödeme, audit ve müşteri/rapor borcu üzerinden uzlaştırın. Hata, latency, 401/403/429/5xx ve D1 okuma bütçesi izlenir. Banka/POS iadesi yapılıyormuş gibi kabul testi yapılmaz.

## 10. Geri dönüş

Önce yazmaları durdurun ve belirsiz sonuçları inceleyin; yeni anahtarla otomatik tekrar yapmayın. Şema eklemeli olduğundan çalışan tablo/finansal kayıtlar silinmez. Geri dönülecek API sürümü **0002 hareketlerini ve ödemeli iptal ledger’ını anlayabilmelidir**; yeni finansal kayıtlar oluşmuşken eski 0001 uygulamasına körlemesine dönmek tarihsel hesapları bozabilir. Uyumlu sürüm yoksa yazmaları kapalı tutup kontrollü ileri düzeltme tercih edilir.

Veri bozulmasında güncel durumu ve olay kayıtlarını koruyun, operatör onayıyla doğru UTC/bookmark seçin ve önce staging’de kurtarmayı prova edin. Time Travel restore hedef veritabanını **yerinde üzerine yazar**; bookmark sonrası meşru işlemler kaybolabilir. İşletme/banka belgeleri ve audit ile kayıp aralığını uzlaştırmadan trafiği açmayın. Bu belge otomatik üretim restore komutu içermez; gerçek restore ayrı açık yetki ve olay planıyla gerçekleştirilir. Bootstrap kilidi, kullanıcı yetkileri, oturumların iptal durumu ve idempotency geçmişi ayrıca kontrol edilir. [Restore davranışı](https://developers.cloudflare.com/d1/reference/time-travel/).
