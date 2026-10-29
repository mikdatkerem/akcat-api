# AKÇAT API

Cloudflare Workers + TypeScript üzerinde Hono yönlendirmesi, Chanfana OpenAPI ve Zod doğrulaması kullanan bağımsız API’dir. Web ve gelecekteki mobil istemci bu servisi kullanır. D1’e yalnızca API erişir.

- Giriş noktası: src/index.ts
- Yapılandırma: wrangler.jsonc
- D1 binding: DB → akcat-db
- Migration: `migrations/0001_initial_schema.sql` dokuz temel tabloyu; `0002_financial_adjustments.sql` ek düzeltme tablosu/indekslerini; `0003_sale_item_list_price.sql` satış anındaki nullable liste fiyatı snapshot'ını tanımlar. 0003 eski fiyatları doldurmaz. Yeni fiyatlandırma API'sinden önce operatör tarafından uygulanmalıdır; migration otomatik çalıştırılmaz. Yerel ve canlı migration durumları ayrıdır.
- Sağlık kontrolü: GET /api/health; SELECT 1 ile D1 bağlantısını okur. Şemayı/migration durumunu doğrulamaz.
- OpenAPI arayüzü: /
- İş endpoint’leri /api/v1 altındadır.
- Örnek Task endpoint’leri kaldırılmıştır. `/api/v1/auth/login`, `/logout`, `/me` giriş/oturum endpoint’leri hazırdır.
- Kimlik doğrulama, güvenlik sınırları ve ilk admin kurulumu: [docs/AUTH.md](docs/AUTH.md).
- Yalnızca admin'e açık kullanıcı listeleme/oluşturma/detay/PATCH, parola sıfırlama ve geçmişi olmayan hesabı kalıcı silme: [docs/USERS.md](docs/USERS.md). Kendi hesabını silme/son aktif admin koruması, atomik audit ve oturum iptali mevcut tablolarla uygulanır; finansal veya bağlı denetim geçmişi korunur. Yeni migration yoktur.
- Müşteri listeleme/arama/sayfalama, oluşturma, detay ve düzenleme hazırdır: [docs/CUSTOMERS.md](docs/CUSTOMERS.md). Aktiflik ve geçmişi olmayan müşteriyi kalıcı silme yalnızca admin'e açıktır; geçmişi bulunan müşteri pasife alınabilir, kayıtları ve raporları korunur.
- Ürün listeleme/arama/sayfalama, detay ve admin oluşturma/fiyat/aktiflik düzenlemesi hazırdır: [docs/PRODUCTS.md](docs/PRODUCTS.md). Admin geçmiş satışlarda hiç kullanılmamış aktif/pasif ürünü onayla kalıcı silebilir; `DELETE /api/v1/products/:id` idempotent ve audit ile atomiktir. Employee yalnızca okur; geçmişte kullanılmış ürün ve finansal kayıtlar silinmez.
- Satış oluşturma, tarih/müşteri filtreli geçmiş ve detay hazırdır: [docs/SALES.md](docs/SALES.md). İki rol tüm şirket satışlarını görür/oluşturur; sunucu fiyatı, snapshot, ilk ödeme ve audit tek atomik batch’tedir.
- Sonradan tahsilat, borçlu müşteri listesi, müşteri açık satışları ve finansal hareketler hazırdır: [docs/FINANCE.md](docs/FINANCE.md). Çalışan başka çalışanın satışına tahsilat yapabilir; koşullu SQL kalan borcu aynı yazma transaction’ında doğrular, tahsilat/audit atomiktir. Serbest düzenleme/silme veya admin yetkisi açılmaz.
- Koşullu ödemesiz satış iptali ve düzeltme talebi oluşturma/listeleme/detay/admin onay/ret hazırdır: [docs/CORRECTIONS.md](docs/CORRECTIONS.md). İptal ve karar/audit tek atomik batch’tedir; ledger asıl borcu korur ve ayrı iptal hareketiyle kapatır. Admin tam hatalı kayıt ters kaydı veya fiilen tamamlanmış harici tam iadeyi ayrı türlerde kaydeder. Ödemeli iptal bütün ödemeler tipli tam karşı kayıtla kapatılınca ayrı onaylanır. [Finansal düzeltme sözleşmesi](docs/FINANCIAL_ADJUSTMENTS.md) ve `0002` migration’ı eklendi; paket/binding değişmedi. Yerel ve uzak migration durumları ayrı doğrulanmalıdır; [yerel hata düzeltme kaydı](docs/LOCAL_FIXES.md) güncel yerel durumu açıklar.
- Beş salt okunur finansal rapor hazırdır: `GET /api/v1/reports/summary`, `/sales`, `/payments`, `/receivables`, `/employees`. Satış/tahsilat kendi kayıt tarihleri, açık borç tüm dönemler üzerinden hesaplanır; Türkiye günlerini API belirler. Çalışan yönetim raporu admin’e özeldir. Nakit Tahsilat fiziksel kasa bakiyesi değildir; kasa çıkış/kapanışı yoktur. Sözleşme, indeks değerlendirmesi ve testler: [docs/REPORTS.md](docs/REPORTS.md).

## Yerel geliştirme

Bu klasörde, Windows PowerShell:

```powershell
Copy-Item .dev.vars.example .dev.vars # Yalnızca dosya henüz yoksa; mevcut ayarları ezmeyin.
npm.cmd run dev -- --local --port 8787
```

İlk kurulumda ve yeni migration geldiğinde, mevcut yerel verinin yedeğini alıp `npm.cmd run db:migrate:local` çalıştırın. Bu komut yalnızca yerel D1'e bekleyen mevcut migration'ları uygular; uzak veritabanına bağlanmaz. `0002` eksikse boş geçmişte bile ödeme/ledger/rapor okumaları ve atomik tahsilat yanıt sorgusu başarısız olur. API bu bilinen eksikliği `503 DATABASE_SCHEMA_REQUIRED` ile bildirir; şema eksikliği boş liste veya başarılı işlem sayılmaz. Health yalnızca bağlantıyı denetler. Migration otomatik başlatılmaz ve finansal kısıtlar atlanmaz.

Diğer kabuklarda npm run dev -- --local --port 8787 kullanılabilir. --local uzaktaki binding’leri devre dışı bırakır. Mevcut yerel D1 durumu kullanılır; migration veya seed otomatik çalıştırılmaz. Sağlık kontrolü http://localhost:8787/api/health adresindedir. Web’in localhost:5173 üzerindeki Vite proxy’si aynı servise yönlendirir.

## Kontroller

Her iki rolün hesap bilgileri ve güvenli parola değiştirme sözleşmesi: [Hesabım](docs/ACCOUNT.md). `POST /api/v1/auth/change-password` mevcut parolayı doğrular; güncelleme/audit/tüm oturum iptali atomiktir. Migration veya yeni binding gerekmez.

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

`build` yalnızca `wrangler deploy --dry-run --outdir dist` ile yerel bundle üretir; yükleme/deploy yapmaz. `test`, gerçek Workers runtime’ını ayrı test yapılandırması, farklı D1 kimliği ve geçici OS dizininde başlatır; mevcut yerel veya uzak D1’i kullanmaz. Şema ve kullanıcı fixture’ları yalnızca bu izole test veritabanında oluşturulur ve test sonunda geçici dizin temizlenir. Node.js 22.13+ gerekir; paylaşılan TypeScript modülleri CLI/testlerde `--experimental-strip-types` ile çalışır. API için lint komutu yoktur. Gerçek deploy, migration uygulama ve ilk admin kurulumu açık operatör eylemidir; testler gerçek admin oluşturmaz.

Üretim öncesi denetim, yerel performans probu (`npm.cmd run audit:performance`) ve açık kalan çıkış kapıları: [PRODUCTION_AUDIT.md](docs/PRODUCTION_AUDIT.md). Manuel yapılandırma, yedek/kurtarma, migration ve edge ölçüm planı: [RELEASE_RUNBOOK.md](docs/RELEASE_RUNBOOK.md). Bu belgeler deploy yetkisi veya uygulanmış uzak migration anlamına gelmez.
