/**
 * Daftarkan (atau hapus) webhook Telegram beserta secret_token.
 *
 * Dijalankan USER setelah deploy (bukan oleh Claude Code). Butuh env:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, PUBLIC_BASE_URL
 *
 * Cara pakai:
 *   npm run set-webhook            # set webhook ke {PUBLIC_BASE_URL}/api/telegram
 *   npm run set-webhook -- --info  # lihat status webhook saat ini
 *   npm run set-webhook -- --delete# hapus webhook
 *
 * Catatan: secret_token dikirim ke Telegram; Telegram akan menyertakannya di
 * header X-Telegram-Bot-Api-Secret-Token pada tiap update. Route memverifikasinya.
 */

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`✗ Environment variable ${name} belum di-set.`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const token = env("TELEGRAM_BOT_TOKEN");
  const api = `https://api.telegram.org/bot${token}`;
  const arg = process.argv[2];

  if (arg === "--info") {
    const res = await fetch(`${api}/getWebhookInfo`);
    const json = await res.json();
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  if (arg === "--delete") {
    const res = await fetch(`${api}/deleteWebhook`, { method: "POST" });
    const json = await res.json();
    console.log(json.ok ? "✓ Webhook dihapus." : "✗ Gagal:", json);
    return;
  }

  const base = env("PUBLIC_BASE_URL").replace(/\/$/, "");
  const secret = env("TELEGRAM_WEBHOOK_SECRET");
  const url = `${base}/api/telegram`;

  const res = await fetch(`${api}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      secret_token: secret,
      // Hanya perlu message & callback_query; hemat trafik.
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    }),
  });
  const json = await res.json();
  if (json.ok) {
    console.log(`✓ Webhook di-set ke ${url}`);
  } else {
    console.error("✗ Gagal set webhook:", json);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("✗ Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
