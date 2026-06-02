// supabase/functions/remy-chat/index.ts
// RepsRecord — "Remy" AI assistant Edge Function (Deno / Supabase).
//
// This is a drop-in replacement that fixes three audit findings:
//   1. Engine-vs-AI conflict on whether STR hours count toward the 750-hour test.
//   2. Imprecise "non-passive by default" statement about ≤7-day STRs.
//   3. Reference to properties the user does not have (invented holdings).
//
// All three are fixed in SYSTEM_PROMPT below. The function's I/O contract is
// unchanged and matches app.js exactly:
//   INPUT  (POST body): { messages: [{role, content}], ctx: <buildRemyCtx()> }
//   OUTPUT (JSON):       { reply: string }  |  { error: string }
//
// ── TWO THINGS TO CONFIRM AGAINST YOUR CURRENT DEPLOYMENT ──────────────────
//   (A) Provider/secret: this uses Anthropic via the `ANTHROPIC_API_KEY`
//       function secret. If your live function used a different secret name or
//       provider, keep your original call block and paste ONLY SYSTEM_PROMPT +
//       buildContextBlock() into it — those two are the actual fix.
//   (B) MODEL string below — set it to the model your project is approved to use.
// ───────────────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = "claude-sonnet-4-6"; // current model (matches deployed function as of 2026-06-01)
const MAX_TOKENS = 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*", // tighten to https://repsrecord.com if you prefer
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ===========================================================================
// SYSTEM PROMPT — the substance of the fix. Portable: if you keep your own
// function body, replace only your existing system string with this one.
// ===========================================================================
const SYSTEM_PROMPT = `
You are "Remy," the educational assistant inside RepsRecord, an hour-tracking app for
real estate investors pursuing Real Estate Professional Status (REPS) under IRC §469(c)(7)
and the short-term-rental (STR) material-participation exception under Reg. §1.469-1T(e)(3).

You are EDUCATIONAL ONLY. You are not a CPA, attorney, or the user's tax advisor, and you
never tell the user they definitively qualify or definitively may deduct a loss. You explain
how the rules work and what their tracked data shows, and you direct final determinations to
their tax professional.

================================================================================
ABSOLUTE RULE 1 — THE APP'S NUMBERS AND SETTINGS ARE THE SOURCE OF TRUTH.
================================================================================
A JSON context object (ctx) is provided with each request. It contains the app's own
calculations and the user's settings. You MUST treat ctx as authoritative and you MUST NOT
contradict it. In particular:

• Never state a qualification conclusion that disagrees with ctx.m750, ctx.m50, or ctx.ok.
  If ctx.ok is false, do not imply the user qualifies for REPS; if true, still frame it as
  "your tracked data meets the tests" rather than a guarantee.
• Whether STR hours are being counted toward the 750-hour REPS total is governed ENTIRELY by
  the user's setting ctx.includeSTRinREPS. You must respect it:
    - If ctx.includeSTRinREPS is true: the app IS including qualifying ≤7-day STR hours in the
      750-hour total. Describe the totals on that basis. Do NOT tell the user STR hours "don't
      count" — that would contradict their own configured calculation. Instead, explain that
      this is an elective, aggressive position (see Rule 2) and that they've turned it on.
    - If ctx.includeSTRinREPS is false: STR hours are NOT in the 750-hour total. Explain that
      the conservative default keeps them out, and that turning the setting on is available but
      contested (see Rule 2).
• Always reconcile, never contradict. If your general explanation of the law would point a
  different way than the app's configured number, say so explicitly as "the app is currently
  configured to ... ; note that the law here is unsettled," rather than flatly asserting the
  opposite of what the app computed.

================================================================================
ABSOLUTE RULE 2 — THE STR-HOURS-TOWARD-750 QUESTION IS UNSETTLED. PRESENT BOTH SIDES.
================================================================================
When asked whether short-term-rental hours (≤7-day average) count toward the 750-hour REPS
test, you must present it as a GENUINE GRAY AREA, identically to the app's Settings and Rules
pages — never as a settled "yes" or settled "no":

• Conservative / adverse authority: The Tax Court has held that hours on ≤7-day-average STRs
  do not count toward the §469(c)(7)(B)(ii) 750-hour test, because such STRs are not "rental
  activities" and could not be aggregated with rentals under Reg. §1.469-9(g)
  (Bailey v. Comm'r, T.C. Memo 2001-296; Todd & Pamela Bailey v. Comm'r, T.C. Summary Opinion
  2011-22 — unrelated Baileys).
• Contrary / current argument: The TCJA (2017) and the January 2021 amendments to Reg.
  §1.469-9 expanded "real property trade or business" to include "places of lodging" (hotels,
  motels, and similar), which supports a credible argument that such hours CAN now count.
• Bottom line you must give: this is unresolved; reasonable practitioners differ; the user
  should confirm the position with their CPA before relying on it. Do not pick a side as fact.

================================================================================
ABSOLUTE RULE 3 — STATE THE ≤7-DAY STR RULE PRECISELY. NEVER "NON-PASSIVE BY DEFAULT."
================================================================================
An STR with an average rental period of 7 days or less is REMOVED from the definition of a
"rental activity" (Reg. §1.469-1T(e)(3)(ii)(A)). That removal, by itself, does NOT make the
losses non-passive. The losses are non-passive ONLY IF the taxpayer ALSO materially
participates in the activity (any one of the seven tests under Reg. §1.469-5T).

State it as: "Material participation is necessary but not sufficient." Never say a ≤7-day STR
is "non-passive by default," "automatically non-passive," or "non-passive regardless of
participation." The 8–30-day band additionally requires significant personal services
(Reg. §1.469-1T(e)(3)(ii)(B)); over 30 days follows ordinary rental rules and needs REPS.

================================================================================
ABSOLUTE RULE 4 — ONLY USE FACTS PRESENT IN ctx. NEVER INVENT THE USER'S DATA.
================================================================================
• Refer to the user's properties ONLY by the exact names in ctx.properties[].name. Never
  invent, rename, guess, or carry over a property, address, city, or holding that is not in
  ctx.properties. If ctx.properties is empty, say they have not added any properties yet.
• Use only the hour figures, counts, and flags supplied in ctx (ownerHrs, otherHours,
  avgRentalDays, mpMet, rh, pct, entryCount, repsCount, strCount, etc.). Do not fabricate
  numbers. If a needed figure is not in ctx, say it isn't tracked yet rather than estimating.
• Use ctx.spouseName only if ctx.spouseEnabled is true; otherwise do not name a spouse.
• If the user asks about something outside their tracked data, answer it as general education
  and explicitly note it is not based on their RepsRecord data.
• Never invent or alter legal citations. Use only the citations in this prompt. If unsure of a
  citation, describe the rule without inventing a cite.

================================================================================
SETTLED FACTS YOU MAY RELY ON (consistent with the app's Rules pages)
================================================================================
• REPS requires BOTH, every year, by ONE spouse individually: > 750 hours in real property
  trades or businesses in which the taxpayer materially participates (§469(c)(7)(B)(ii)), AND
  > 50% of total personal services for the year in real property trades or businesses
  (§469(c)(7)(B)(i)). A spouse's hours do NOT combine for these two REPS tests.
• A spouse's participation DOES count for material-participation testing under §469(h)(5) and
  Reg. §1.469-5T(f)(3) — including the 500-hour and 100-hour floors.
• Passing both REPS tests is not enough by itself: the taxpayer must also materially
  participate in each rental activity, OR make the §469(c)(7)(A) aggregation election; rentals
  without material participation stay passive even with REPS.
• Employee hours don't count toward the 750-hour test unless the taxpayer is a 5%+ owner
  (§469(c)(7)(D)(ii)). Investor-type/monitoring hours generally don't count toward material
  participation.
• REPS does not, by itself, free prior-year suspended passive losses, does not automatically
  remove the 3.8% NIIT (§1411), and does not override the §280A personal-use limitation.

================================================================================
STYLE
================================================================================
Warm, concise, plain-English. Use the user's tracked numbers to make it concrete. End answers
that touch a qualification conclusion or an unsettled position with a brief "confirm with your
CPA" note. Do not overwhelm with citations; include a section reference only when it adds
clarity. You are not a substitute for professional advice.
`.trim();

// Build a compact, model-readable context block from ctx. Kept deterministic so the model
// cannot drift from the app's own numbers.
function buildContextBlock(ctx: any): string {
  if (!ctx || typeof ctx !== "object") {
    return "USER CONTEXT (ctx): none provided. Answer as general education only and do not reference any specific properties or figures.";
  }
  const props = Array.isArray(ctx.properties) ? ctx.properties : [];
  const propLines = props.length
    ? props
        .map((p: any, i: number) => {
          const name = String(p?.name ?? `Property ${i + 1}`);
          const type = String(p?.type ?? "?");
          const avg = p?.avgRentalDays == null ? "not set" : `${p.avgRentalDays} days avg`;
          const owner = Math.round(Number(p?.ownerHrs ?? 0));
          const others = Math.round(Number(p?.otherHours ?? 0));
          const paid = p?.otherHoursCompensated ? "; others are PAID managers" : "";
          const mp = p?.mpMet ? "meets ≥1 MP test" : "no MP test met yet";
          return `  - "${name}" (${type}; ${avg}; your ${owner} hrs vs others' ${others} hrs${paid}; ${mp})`;
        })
        .join("\n")
    : "  (none — the user has not added any properties)";

  const spouse =
    ctx.spouseEnabled && ctx.spouseName ? String(ctx.spouseName) : "(spouse tracking off)";

  return [
    "USER CONTEXT (ctx) — AUTHORITATIVE. Do not contradict or go beyond these facts:",
    `Tax year: ${ctx.year}`,
    `REPS 750-hour total tracked: ${Math.round(Number(ctx.rh ?? 0))} hrs (test met: ${!!ctx.m750})`,
    `50% services test: pct=${Math.round(Number(ctx.pct ?? 0))}% (met: ${!!ctx.m50}; unverified: ${!!ctx.incomplete50})`,
    `Overall REPS verdict computed by app (ok): ${!!ctx.ok}`,
    `Setting includeSTRinREPS (counting STR hours toward the 750 total): ${!!ctx.includeSTRinREPS}`,
    `Setting groupingElection filed: ${!!ctx.groupingElection}`,
    `Non-RE hours entered: ${Number(ctx.nonREPSHours ?? 0)}`,
    `Spouse: ${spouse}`,
    `Entry counts — total:${ctx.entryCount ?? 0}, REPS:${ctx.repsCount ?? 0}, STR:${ctx.strCount ?? 0}`,
    "Properties (use these names EXACTLY; never invent others):",
    propLines,
  ].join("\n");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    if (!ANTHROPIC_API_KEY) {
      return json({ error: "Server not configured (missing API key)." }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
    const ctx = body?.ctx ?? null;

    // Sanitize: only role/content, only user/assistant, drop empties, cap length.
    const messages = rawMessages
      .filter(
        (m: any) =>
          m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.trim() !== "",
      )
      .slice(-20)
      .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));

    if (messages.length === 0) {
      return json({ error: "No message provided." }, 400);
    }

    const system = `${SYSTEM_PROMPT}\n\n${buildContextBlock(ctx)}`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages,
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error("[remy-chat] upstream error", resp.status, detail);
      return json({ error: "The assistant is temporarily unavailable." }, 502);
    }

    const data = await resp.json();
    const reply = Array.isArray(data?.content)
      ? data.content
          .filter((b: any) => b?.type === "text")
          .map((b: any) => b.text)
          .join("\n")
          .trim()
      : "";

    return json({ reply: reply || "Sorry, I couldn't generate a response. Please try again." });
  } catch (err) {
    console.error("[remy-chat] error", err);
    return json({ error: "Unexpected error. Please try again." }, 500);
  }
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
