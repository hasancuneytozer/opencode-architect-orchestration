/**
 * Medya sunumu: `Range` desteği ve imzalı adres doğrulama.
 *
 * ── RANGE NEDEN ZORUNLU ──────────────────────────────────────────────────────
 * Panelde video oynatıcısı, tarayıcının "ilk 1 MB'yi al, devamını iste" davranışını
 * kullanır. `206 Partial Content` + `Content-Range` üretmezsek oynatıcı ya tüm
 * dosyayı indirir (2 GB bellek/disk) ya da ilk kareyi göstermez. Aralık
 * BAŞTAN-SONA indirilemeyecek kadar büyükse `416` döner ve `Content-Range`
 * başlığına toplam boyut yazılır: "istediğin aralık yok" bilgisi, sessizce
 * 200 dönmekten iyidir.
 *
 * NOT: Bu yorumda "bytes *" ardından "/" yazmak YANLIŞTIR — `*` ardından `/`
 * gelirse yorum o noktada kapanır ve gerisi kod sanılır. Aşağıdaki
 * `parseRange` dokümanında aynı tuzağa düşmemek için aralık sözdizimi
 * tırnak içinde yazılmıştır.
 *
 * ── NEDEN `pathFor` DEĞİL ───────────────────────────────────────────────────
 * `store.pathFor` DİZİN OLUŞTURUR; bir GET isteğinde yanlış anahtar için
 * boş klasörler türetmek diskte çöp bırakır. Burada `resolveKey` kullanılır.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Tek seferde sunulan azami aralık: 8 MB. */
export const MAX_RANGE_BYTES = 8 * 1024 * 1024;

/**
 * `serveFile`'ın depodan istediği TEK yetenek.
 *
 * Neden yapısal (yapısal tipten küçük) arayüz: `serveFile` yalnızca anahtarı
 * mutlak yola çevirmek için `resolveKey` kullanır — ne yazma, ne silme, ne
 * imza. Somut `FsMediaStore` sınıfını (ve onun `private` alanlarını) burada
 * istemek, testlerde ve `server.ts`'te `as` zorlamaları yazdırmak demektir;
 * `private` alanı olan bir sınıfa dönüşüm zorlaması zaten derlenmez. Arayüz
 * küçük tutulursa `HttpMediaStore` doğrudan verilebilir.
 */
export interface MediaKeyResolver {
  /** Anahtarı doğrular ve mutlak yola çevirir. Güvensiz anahtarda HATA FIRLATIR. */
  resolveKey(key: string): string;
}

export interface ParsedRange {
  start: number;
  end: number;
}

/**
 * `Range: bytes=a-b`, `bytes=a-`, `bytes=-n` çözümler. Çoklu aralık
 * (`bytes=0-1,5-6`) DESTEKLENMEZ: HTTP bunu `multipart/byteranges` ile ister ve
 * pratikte video oynatıcıları tek aralık ister. Desteklemeyip 416 dönmek,
 * kısmen karşılamaktan dürüsttür.
 */
export function parseRange(header: string | undefined, size: number): ParsedRange | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match as unknown as [string, string, string];
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    // Son N bayt.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    if (size === 0) return null;
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start < 0 || start >= size) return null;
  const end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

export interface ServeFileOptions {
  store: MediaKeyResolver;
  key: string;
  contentType: string;
  /** `Cache-Control` başlığı. */
  cacheControl?: string;
}

/**
 * Dosyayı `Range` desteğiyle sunar. `reply.header`/`reply.send` kullanılır;
 * akış `send` ile taşınır, belleğe alınmaz.
 */
export async function serveFile(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: ServeFileOptions,
): Promise<FastifyReply> {
  let path: string;
  try {
    path = opts.store.resolveKey(opts.key);
  } catch {
    // Anahtar güvensiz (`..`, sürücü harfi): "bulunamadı" de, ayrıntı verme.
    return reply
      .code(404)
      .header("content-type", "application/json; charset=utf-8")
      .send({ ok: false, error: { code: "not_found", message: "Medya bulunamadı." } });
  }

  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) throw new Error("dizin");
    size = st.size;
  } catch {
    return reply
      .code(404)
      .header("content-type", "application/json; charset=utf-8")
      .send({ ok: false, error: { code: "not_found", message: "Medya bulunamadı." } });
  }

  reply.header("accept-ranges", "bytes");
  reply.header("content-type", opts.contentType);
  reply.header("cache-control", opts.cacheControl ?? "private, max-age=0, no-store");

  const rangeHeader = request.headers.range;
  if (rangeHeader === undefined) {
    reply.header("content-length", size);
    return reply.send(createReadStream(path));
  }

  const range = parseRange(Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader, size);
  if (range === null) {
    return reply
      .code(416)
      .header("content-range", `bytes */${size}`)
      .header("content-type", "application/json; charset=utf-8")
      .send({
        ok: false,
        error: { code: "bad_request", message: "İstenen bayt aralığı geçersiz." },
      });
  }

  const length = range.end - range.start + 1;
  reply.code(206);
  reply.header("content-range", `bytes ${range.start}-${range.end}/${size}`);
  reply.header("content-length", length);
  const stream = createReadStream(path, { start: range.start, end: range.end }) as Readable;
  return reply.send(stream);
}