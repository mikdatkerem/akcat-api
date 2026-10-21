# AKÇAT API

Cloudflare Workers + TypeScript üzerinde Hono yönlendirmesi, Chanfana OpenAPI ve Zod doğrulaması kullanan bağımsız API’dir. Web ve gelecekteki mobil istemci bu servisi kullanır. D1’e yalnızca API erişir.

- Giriş noktası: src/index.ts
- Yapılandırma: wrangler.jsonc
- D1 binding: DB → akcat-db
- Migration: migrations/0001_initial_schema.sql; dokuz temel tablo tanımlıdır. Yerel ve canlı migration durumları ayrıdır.
- Sağlık kontrolü: GET /api/health; SELECT 1 ile D1 bağlantısını okur. Şemayı/migration durumunu doğrulamaz.
- OpenAPI arayüzü: /
- Yeni iş endpoint’leri: /api/v1 altında geliştirilecektir.
- Örnek Task endpoint’leri kaldırılmıştır. `/api/v1/auth/login`, `/logout`, `/me` giriş/oturum endpoint’leri hazırdır. İş endpoint’leri henüz yoktur.
- Kimlik doğrulama, güvenlik sınırları ve ilk admin kurulumu: [docs/AUTH.md](docs/AUTH.md).

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
