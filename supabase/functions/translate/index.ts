// 실시간 통역: 한 문장을 받아 Claude로 번역하고, 번역문을 text/plain 스트림으로 돌려준다.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-sonnet-5-5";
const LANG_NAME: Record<string, string> = { en: "English", ko: "Korean" };
const ALLOWED = (Deno.env.get("ALLOWED_EMAILS") ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const anthropic = new Anthropic(); // ANTHROPIC_API_KEY secret

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function systemPrompt(sl: string, tl: string) {
  return `You are a professional simultaneous interpreter. Translate the speaker's ${LANG_NAME[sl]} speech into natural spoken ${LANG_NAME[tl]} for live subtitles.

The input comes from speech recognition, so it may lack punctuation or contain misheard words; infer the intended meaning from context. Keep names, numbers and technical terms accurate, and keep terminology consistent with earlier lines. Output only the ${LANG_NAME[tl]} translation of the latest line, with no quotes, notes or explanations.

Latency-sensitive; begin your visible answer immediately.`;
}

type Ctx = { orig: string; trans: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  // 로그인 사용자 확인 + 허용 목록 검사 (API 비용 보호)
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json(401, { error: "로그인이 필요합니다." });
  if (ALLOWED.length && !ALLOWED.includes((user.email ?? "").toLowerCase())) {
    return json(403, { error: "통역 사용 권한이 없는 계정입니다." });
  }

  let body: { text?: string; sl?: string; tl?: string; context?: Ctx[] };
  try { body = await req.json(); } catch { return json(400, { error: "invalid json" }); }
  const text = (body.text ?? "").trim().slice(0, 2000);
  const { sl = "en", tl = "ko" } = body;
  if (!text || !LANG_NAME[sl] || !LANG_NAME[tl]) return json(400, { error: "text, sl, tl 확인" });

  const context = (body.context ?? []).slice(-5);
  const prior = context.length
    ? "Earlier lines (for context only):\n" + context.map((c) => `- ${c.orig}\n  → ${c.trans}`).join("\n") + "\n\n"
    : "";

  const stream = anthropic.beta.messages.stream({
    model: MODEL,
    max_tokens: 1024,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    // deno-lint-ignore no-explicit-any
    fallbacks: "default" as any,
    system: systemPrompt(sl, tl),
    messages: [{ role: "user", content: `${prior}Translate this line:\n${text}` }],
  });

  const enc = new TextEncoder();
  const out = new ReadableStream({
    async start(controller) {
      stream.on("text", (delta) => controller.enqueue(enc.encode(delta)));
      try {
        const msg = await stream.finalMessage();
        if (msg.stop_reason === "refusal") controller.enqueue(enc.encode("[번역할 수 없는 내용입니다]"));
      } catch (e) {
        console.error("claude error", e);
        controller.enqueue(enc.encode("[번역 실패 – 잠시 후 다시 시도]"));
      }
      controller.close();
    },
    cancel() { stream.abort(); },
  });

  return new Response(out, {
    headers: { ...cors, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
});
