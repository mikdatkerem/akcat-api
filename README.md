# AKÇAT API

Cloudflare Workers + TypeScript üzerinde Hono yönlendirmesi, Chanfana OpenAPI ve Zod doğrulaması kullanan bağımsız API’dir. Web ve gelecekteki mobil istemci bu servisi kullanır. D1’e yalnızca API erişir.

- Giriş noktası: src/index.ts
- Yapılandırma: wrangler.jsonc
- D1 binding: DB → akcat-db
- Migration: migrations/0001_initial_schema.sql; dokuz temel tablo tanımlıdır. Yerel ve canlı migration durumları ayrıdır.
- Sağlık kontrolü: GET /api/health; SELECT 1 ile D1 bağlantısını okur. Şemayı/migration durumunu doğrulamaz.
- OpenAPI arayüzü: /
- İş endpoint’leri /api/v1 altındadır.
- Örnek Task endpoint’leri kaldırılmıştır. `/api/v1/auth/login`, `/logout`, `/me` giriş/oturum endpoint’leri hazırdır.
- Kimlik doğrulama, güvenlik sınırları ve ilk admin kurulumu: [docs/AUTH.md](docs/AUTH.md).
- Müşteri listeleme/arama/sayfalama, oluşturma, detay ve düzenleme hazırdır: [docs/CUSTOMERS.md](docs/CUSTOMERS.md). Aktiflik yalnızca admin tarafından değiştirilebilir.
- Ürün listeleme/arama/sayfalama, detay ve admin oluşturma/fiyat/aktiflik düzenlemesi hazırdır: [docs/PRODUCTS.md](docs/PRODUCTS.md). Employee yalnızca okur; oluşturma idempotent, yazmalar audit ile atomiktir.
- Satış oluşturma, tarih/müşteri filtreli geçmiş ve detay hazırdır: [docs/SALES.md](docs/SALES.md). İki rol tüm şirket satışlarını görür/oluşturur; sunucu fiyatı, snapshot, ilk ödeme ve audit tek atomik batch’tedir.
- Sonradan tahsilat, borçlu müşteri listesi, müşteri açık satışları ve finansal hareketler hazırdır: [docs/FINANCE.md](docs/FINANCE.md). Çalışan başka çalışanın satışına tahsilat yapabilir; koşullu SQL kalan borcu aynı yazma transaction’ında doğrular, tahsilat/audit atomiktir. Serbest düzenleme/silme veya admin yetkisi açılmaz.
- Koşullu ödemesiz satış iptali ve düzeltme talebi oluşturma/listeleme/detay/admin onay/ret hazırdır: [docs/CORRECTIONS.md](docs/CORRECTIONS.md). İptal ve karar/audit tek atomik batch’tedir; ledger asıl borcu korur ve ayrı iptal hareketiyle kapatır. Admin sadece ödemesiz satış iptal talebini onaylayabilir. Ödeme düzeltmesi/ters kayıt/iade ve kasa raporu henüz yoktur. Migration/paket eklenmedi.

## Yerel geliştirme

Bu klasörde, Windows PowerShell:

```powershell
Copy-Item .dev.vars.example .dev.vars # Yalnızca dosya henüz yoksa; mevcut ayarları ezmeyin.
npm.cmd run dev -- --local --port 8787
```

Diğer kabuklarda npm run dev -- --local --port 8787 kullanılabilir. --local uzaktaki binding’leri devre dışı bırakır. Mevcut yerel D1 durumu kullanılır; migration veya seed otomatik çalıştırılmaz. Sağlık kontrolü http://localhost:8787/api/health adresindedir. Web’in localhost:5173 üzerindeki Vite proxy’si aynı servise yönlendirir.

## Kontroller

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

`build` yalnızca `wrangler deploy --dry-run --outdir dist` ile yerel bundle üretir; yükleme/deploy yapmaz. `test`, gerçek Workers runtime’ını ayrı test yapılandırması, farklı D1 kimliği ve geçici OS dizininde başlatır; mevcut yerel veya uzak D1’i kullanmaz. Şema ve kullanıcı fixture’ları yalnızca bu izole test veritabanında oluşturulur ve test sonunda geçici dizin temizlenir. Node.js 22.13+ gerekir; paylaşılan TypeScript modülleri CLI/testlerde `--experimental-strip-types` ile çalışır. API için lint komutu yoktur. Gerçek deploy, migration uygulama ve ilk admin kurulumu açık operatör eylemidir; testler gerçek admin oluşturmaz.
