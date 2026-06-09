/**
 * Telegram notifikace — stejný bot jako hlavní app (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).
 */
export async function sendTelegram(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn("[telegram] Chybí TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — zpráva neodeslána");
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error("[telegram] API vrátilo chybu:", res.status, await res.text());
    }
  } catch (err) {
    console.error("[telegram] Odeslání selhalo:", err);
  }
}
