/**
 * Monitoring kreditů — denní přehled + prahové alerty do Telegramu.
 *
 * Sledované služby:
 *   - Brevo SMS  (alert < BREVO_SMS_LOW, default 100)
 *   - Twilio     (alert < TWILIO_BALANCE_LOW, default 5 USD)
 *   - Anthropic  (útrata tento měsíc — jen informativně)
 *   - Vapi       (bez veřejného API → týdenní připomínka ruční kontroly)
 */
import { sendTelegram } from "../lib/telegram";
import { getBrevoSmsCredits, getTwilioBalance, type ProviderStatus } from "./providers";

const BREVO_SMS_LOW = process.env.BREVO_SMS_LOW ? parseInt(process.env.BREVO_SMS_LOW) : 100;
const TWILIO_BALANCE_LOW = process.env.TWILIO_BALANCE_LOW ? parseFloat(process.env.TWILIO_BALANCE_LOW) : 5;

const VAPI_DASHBOARD_URL = "https://dashboard.vapi.ai";
const ANTHROPIC_CONSOLE_URL = "https://console.anthropic.com/settings/usage";

function line(s: ProviderStatus): string {
  if (s.error) return `⚪️ <b>${s.label}</b>: chyba dotazu (${s.error})`;
  const icon = s.low ? "🔴" : "🟢";
  return `${icon} <b>${s.label}</b>: ${s.value}`;
}

/**
 * Spustí kontrolu a odešle přehled do Telegramu.
 * @param includeWeeklyReminders přidá týdenní připomínky ruční kontroly (Vapi, Anthropic)
 */
export async function runMonitor(includeWeeklyReminders = false): Promise<string> {
  const [brevo, twilio] = await Promise.all([
    getBrevoSmsCredits(BREVO_SMS_LOW),
    getTwilioBalance(TWILIO_BALANCE_LOW),
  ]);

  const statuses = [brevo, twilio];
  const lowCount = statuses.filter((s) => s.low).length;

  const header = lowCount > 0 ? "⚠️ <b>Kredity — pozor, něco dochází</b>" : "💳 <b>Kredity — denní přehled</b>";

  const parts = [header, "", ...statuses.map(line)];

  if (includeWeeklyReminders) {
    parts.push(
      "",
      "🔔 <b>Týdenní ruční kontrola:</b>",
      `   • Vapi → ${VAPI_DASHBOARD_URL}`,
      `   • Anthropic útrata → ${ANTHROPIC_CONSOLE_URL}`
    );
  }

  if (lowCount > 0) {
    parts.push("", "👉 Dobij dotčené služby, ať workflow nespadne.");
  }

  const message = parts.join("\n");
  await sendTelegram(message);
  return message;
}
