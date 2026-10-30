# Hızlı satış (tezgâh satışı)

## İstek ve saklama

Mevcut `POST /api/v1/sales` kullanılır. Admin ve employee aynı authentication, CSRF, Origin, idempotency ve atomik yazma yetkisi denetiminden geçer.

- `sale_type`: `normal` veya `walk_in`; gönderilmezse `normal`.
- Normal: `customer_id` zorunlu UUID, `walk_in_customer_name` NULL/boş. Önceki kısmi ödeme/veresiye davranışı korunur.
- Hızlı: `customer_id` NULL; isteğe bağlı `walk_in_customer_name` yalnızca `sales` üzerinde saklanır. İsim trim/NFC normalize edilir, en fazla 160 karakterdir, kontrol karakterleri reddedilir; boşluk/boş string NULL olur.
- Ürün/miktar, pozitif özel birim fiyat ve `expected_list_price_kurus` sözleşmesi değişmez. Toplam sunucuda hesaplanır.
- Hızlı satışta `payment.method` yalnızca `cash`/`card`; `amount_kurus` sunucu toplamına tam eşit ve pozitif olmalıdır. Eksik/fazla ödeme 422, geçersiz alan/yöntem 400’dür.

Yeni bir müşteri oluşturulmaz. İsimsiz hızlı satışın “Misafir Müşteri” metni yalnızca sunum etiketidir. Gerçek ilişki ve isteğe bağlı isim yanıtın `customer_id`, `walk_in_customer_name` ve `sale_type` alanlarından anlaşılır; detay `customer:null` döner. Bu isim müşteri detayına bağlanmaz.

Normal isteklerin eski canonical hash biçimi korunur. Hızlı satış fingerprint’i ayrıca tür ve normalize ismi kapsar. Aynı key aynı işi bir kez yazar; farklı isim/tür/gövdeyle tekrar 409’dur. Eski API’ye yeni web’in hızlı satış isteği `customer_id:null` gönderdiği için eski UUID doğrulaması 400 verir; normal satışa sessiz dönüşmez.

## Finansal atomiklik ve raporlama

SQL INSERT içinde aktiflik, fiyat beklentisi, sınırlar ve hızlı satışın tam ödeme eşitliği kontrol edilir. Satış, snapshot kalemler, tek ilk ödeme ve audit tek yetkili primary D1 batch’inde yazılır. Ödeme/audit hatası bütün işlemi geri alır. TL metni web’de BigInt üzerinden kuruşa çevrilir; hızlı satışın ödeme tutarı önizleme toplamından otomatik üretilir.

Satış/tahsilat/finansal düzeltme listeleri ve raporları NULL müşteri nedeniyle kayıt düşürmeyen LEFT JOIN kullanır. Dashboard ve aggregate’lar aynı satış/ödeme tablolarını kullanır; ayrı kasa veya ikinci satış sistemi yoktur. Veresiye ve müşteri hareketleri yalnızca gerçek müşteri ilişkilerine dayanır. Hızlı satışa sonradan tahsilat API’de reddedilir; web’de bu işlem sunulmaz.

## İade ve ters kayıt

Tam ödemeli hızlı satış doğrudan iptal edilemez. Çalışan mevcut `payment_reversal` veya `payment_refund` talebini açar, mevcut admin onayı uygulanır. Hatalı tahsilat ters kaydı para transferi değildir; harici iade yalnızca fiilen aynı yöntemle yapılmış tam ödemenin admin teyidi ve referansıyla kaydedilir.

**Hızlı satış istisnası:** Tam ters kayıt/iade aynı batch’te satış iptalini ve bağlantılı `sale.cancelled` audit’ini de yazar. Böylece müşterisiz açık borç oluşmaz. Önizleme/adjustment üzerinde önce/sonra satış ve müşteri borcu 0’dır. Asıl satış, kalem, ilk ödeme ve karşı kayıt silinmez; tekrar onay ikinci ödeme/iptal üretmez. Tek asıl tam ödeme dışında bozulmuş veya desteklenmeyen durumlar onaylanmaz. Normal satışın borcu yeniden açan ve ayrı iptal onayı isteyen mevcut akışı değişmez.

## Web düzeni

Dashboard aksiyonları aynı yeni satış ekranını `#/yeni-satis?mode=normal` veya `#/yeni-satis?mode=walk_in` ile açar. Gönderilmemiş taslağın ürün/isim/müşteri/ödeme alanları bellekte korunur. Sonucu belirsiz ya da kurtarılmış işlem varken yönlendirme orijinal türü/istek gövdesini/anahtarı değiştirmez; kullanıcıya önceki işlemi sonuçlandırma uyarısı gösterilir.

Yeni satışın başındaki Normal Satış / Hızlı Satış düğmeleri erişilebilir pressed durumu taşır. Ürünler ve özel fiyatlar ortaktır. Normal müşteri/tutar/yöntem, hızlı satışın isim ve nakit/kart seçimi ayrı bellek alanlarında korunur; normal banka yöntemi hızlı satışa taşınmaz. Belirsiz yanıtta tür değişimi de kilitlenir, aynı gövde/key tekrar edilir. Hassas taslak kalıcı depolamaya yazılmaz.

Satış tablosundaki müşteri kaymasının kaynağı global `.text-link` üst boşluğuydu. Yalnızca `.sale-table` kapsamında sıfırlandı. Hücreler orta, sayılar sağ hizalıdır; hızlı satış göstergesi aynı müşteri hücresinde kalır. Uzun isimler sarılır. Mobilde mevcut kart/liste ve hamburger/drawer korunur; yeni sütun veya bottom bar eklenmez.

## Migration ve yayın

`0005_walk_in_sales.sql` gereklidir. `sales`, `payments` ve `financial_adjustments` üzerindeki zorunlu müşteri ilişkileri nullable olacak şekilde tablolar yeniden oluşturulur. Sales’e tür/isim alanları ve tür–müşteri CHECK’i eklenir; eski satışlar normal/NULL isim olur. Finansal değerler, ID’ler, zamanlar, idempotency anahtarları, self-FK/reversal ilişkileri ve indeksler kopyalanarak korunur; yeniden hesaplama veya müşteri backfill’i yoktur. Sale items, audit, kullanıcı, müşteri ve ürün tabloları değiştirilmez.

Yabancı anahtarlar kapatılmaz; `PRAGMA defer_foreign_keys` yalnızca aynı transaction bitimine kadar erteler. Dayanak: [D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/) ve [D1 batch rollback](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch). Migration rollback testi, dolu 0004 verisindeki özgün ödeme/karşı kayıt/adjustment değerlerini birebir karşılaştırır; CLI testinde de dolu eski şema yükseltilir ve tekrar uygulama no-op olarak doğrulanır.

Operatör yayın sırası:

1. Hedef D1 ve yedek/kurtarma planını doğrulayın; ayrı staging’de migration süresini ve sonuçları kontrol edin.
2. Yazmaları durdurun, eski API isteklerinin tamamlanmasını bekleyin.
3. Bekleyen migration’ları sırayla, yalnızca yetkili operatör uygulasın. 0001–0004 değiştirilmez.
4. Önce yeni API, sonra yeni web devreye alınsın. Eski sekmeler yenilensin; karma API sürümleriyle yazma açılmasın.
5. FK, eski normal satış/ödeme, müşteri borcu, hızlı satış ve düzeltme akışları doğrulanınca yazmaları açın. `/api/health` yalnızca bağlantı testidir, şema doğrulaması değildir.

İlk hızlı satıştan sonra müşteri zorunlu varsayan eski API’ye basit geri dönüş güvenli değildir: eski INNER JOIN’ler hızlı satışları raporlardan gizleyebilir. Yazmaları kapatın ve NULL müşteriyi destekleyen uyumlu API/web çifti veya ileri düzeltme kullanın. Yeni alanları/tablo verilerini silmeyin; hızlı satışlara sahte müşteri bağlamayın. Eski yedeği geri yüklemek sonradan yazılan finansal kayıtları kaybettirebilir; uzlaştırılmadan yapılmamalıdır. Bu görevde yayın veya uzak migration uygulanmadı.

## Doğrulama

`tests/walk-in.test.mjs`: dolu migration/rollback/FK, isimli/isimsiz ve 160 karakter isim, müşteri oluşturmama, iki rol, cash/card, çok ürün/özel fiyat, eksik/fazla ödeme, yanlış müşteri/tür/yöntem, idempotency, fiyat çakışması, atomik kayıt ve iptal hatası rollback’i, rapor/borç ve tam refund/reversal.

`tests/walk-in.browser.mjs`: mod geçişinde taslak/yöntem koruma, tutarın otomatik yönetimi, güvenli metin gösterimi, kayıp yanıt, fiyat onayı, gerçek karma listede hizalama, 320/390/768/1440 px taşma, NULL müşteri bağlantıları ve admin iade ekranı. Testler yalnızca geçici ve remote binding’i reddeden yerel D1 ortamlarını kullanır. Gerçek üretim migration süresi, Cloudflare edge ve cihazdaki native uygulama davranışı doğrulanmış sayılmaz.
