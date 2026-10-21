import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createInterface, emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { getPlatformProxy, unstable_readConfig } from "wrangler";
import { bootstrapAdmin, BootstrapUnavailable } from "../src/auth/bootstrap.ts";

const project = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  stdout.write("İlk admin: npm run bootstrap:admin -- --local | --remote\nParola yalnızca gizli TTY isteminde alınır. --remote için yetkili Cloudflare API tokenı gerekir.\n");
  process.exit(0);
}
if (args.length !== 1 || !["--local", "--remote"].includes(args[0]) || !stdin.isTTY || !stdout.isTTY) {
  console.error("Tam olarak --local veya --remote ve etkileşimli terminal gerekli. Parolayı argüman veya ortam değişkeni olarak vermeyin.");
  process.exit(1);
}

function question(label) {
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise((resolveAnswer, reject) => {
    rl.once("SIGINT", () => { rl.close(); reject(new Error("İşlem iptal edildi.")); });
    rl.question(label, (answer) => { rl.close(); resolveAnswer(answer); });
  });
}

function secret(label) {
  stdout.write(label);
  emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolveSecret, reject) => {
    let value = "";
    function finish(error) {
      stdin.off("keypress", onKey);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolveSecret(value);
      value = "";
    }
    function onKey(text, key = {}) {
      if (key.ctrl && key.name === "c") return finish(new Error("İşlem iptal edildi."));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") { value = Array.from(value).slice(0, -1).join(""); return; }
      if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    }
    stdin.on("keypress", onKey);
  });
}

let proxy;
try {
  const config = unstable_readConfig({ config: resolve(project, "wrangler.jsonc") });
  const binding = config.d1_databases?.find((item) => item.binding === "DB");
  if (!binding?.database_name || !binding.database_id) throw new Error("DB yapılandırması bulunamadı.");
  const remote = args[0] === "--remote";
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (remote && (!account || !/^[a-f0-9]{32}$/i.test(account) || !apiToken)) {
    throw new Error("Uzak işlem için CLOUDFLARE_ACCOUNT_ID ve D1 düzenleme yetkili CLOUDFLARE_API_TOKEN gerekli.");
  }
  stdout.write(`Hedef: ${remote ? "UZAK / CANLI" : "YEREL"} D1 — ${binding.database_name} (${binding.database_id})\n`);
  if (await question("Onaylamak için veritabanı adını yazın: ") !== binding.database_name) throw new Error("İşlem iptal edildi.");
  const username = await question("İlk admin kullanıcı adı: ");
  const password = await secret("Parola (15–128 karakter, görünmez): ");
  const repeated = await secret("Parolayı tekrarlayın: ");
  if (password !== repeated) throw new Error("Parolalar uyuşmuyor.");
  let execute;
  if (remote) {
    execute = async (batch) => {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${binding.database_id}/query`, {
        method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ batch }),
      });
      const data = await response.json();
      if (!response.ok || !data.success || !Array.isArray(data.result) || data.result.some((result) => !result.success)) {
        throw new Error("D1 işlemi başarısız. Yetkiyi ve kurulum durumunu kontrol edin; hata ayrıntıları güvenlik nedeniyle yazdırılmadı.");
      }
      return data.result;
    };
  } else {
    proxy = await getPlatformProxy({ configPath: resolve(project, "wrangler.jsonc"),
      persist: { path: resolve(project, ".wrangler/state/v3") }, remoteBindings: false });
    execute = (batch) => proxy.env.DB.batch(batch.map(({ sql, params }) => proxy.env.DB.prepare(sql).bind(...params)));
  }
  await bootstrapAdmin(execute, { username, password });
  stdout.write("İlk admin oluşturuldu. Tek kullanımlık kurulum kilidi audit_logs içinde korundu.\n");
} catch (error) {
  // Raw D1/fetch errors can contain query parameters. Never print them.
  const safeMessages = ["İşlem iptal edildi.", "Parolalar uyuşmuyor.", "DB yapılandırması bulunamadı.",
    "Uzak işlem için CLOUDFLARE_ACCOUNT_ID ve D1 düzenleme yetkili CLOUDFLARE_API_TOKEN gerekli.",
    "Kullanıcı adı geçersiz veya parola 15–128 karakter aralığında değil."];
  console.error(error instanceof BootstrapUnavailable || safeMessages.includes(error?.message)
    ? error.message : "Admin kurulumu tamamlanamadı. Yetkiyi, şemayı ve tek kullanımlık kurulum durumunu kontrol edin.");
  process.exitCode = 1;
} finally {
  await proxy?.dispose();
}
