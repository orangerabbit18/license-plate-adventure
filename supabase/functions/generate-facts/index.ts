// Supabase Edge Function: generate-facts
//
// Generates a full set of themed plate facts for a License Plate Adventure session
// (50 states + 3 bonus plates + a wildcard pool) via the Anthropic API, then writes
// them to sessions.custom_facts and flips sessions.facts_status to 'ready' (or
// 'error' on failure) so every connected client picks them up over realtime.
//
// The 53 keyed facts + 15 wildcard facts are generated in small parallel chunks
// (not one giant request) so no single Anthropic response gets cut off by max_tokens.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Must match the keys used by `stateData` / `bonusData` in index.html.
const PLATE_KEYS = [
  { key: "massachusetts", label: "Massachusetts" },
  { key: "california", label: "California" },
  { key: "texas", label: "Texas" },
  { key: "arizona", label: "Arizona" },
  { key: "louisiana", label: "Louisiana" },
  { key: "florida", label: "Florida" },
  { key: "alabama", label: "Alabama" },
  { key: "alaska", label: "Alaska" },
  { key: "arkansas", label: "Arkansas" },
  { key: "colorado", label: "Colorado" },
  { key: "connecticut", label: "Connecticut" },
  { key: "delaware", label: "Delaware" },
  { key: "dc", label: "Washington, D.C." },
  { key: "georgia", label: "Georgia" },
  { key: "hawaii", label: "Hawaii" },
  { key: "idaho", label: "Idaho" },
  { key: "illinois", label: "Illinois" },
  { key: "indiana", label: "Indiana" },
  { key: "iowa", label: "Iowa" },
  { key: "kansas", label: "Kansas" },
  { key: "kentucky", label: "Kentucky" },
  { key: "maine", label: "Maine" },
  { key: "maryland", label: "Maryland" },
  { key: "michigan", label: "Michigan" },
  { key: "minnesota", label: "Minnesota" },
  { key: "mississippi", label: "Mississippi" },
  { key: "missouri", label: "Missouri" },
  { key: "montana", label: "Montana" },
  { key: "nebraska", label: "Nebraska" },
  { key: "nevada", label: "Nevada" },
  { key: "newHampshire", label: "New Hampshire" },
  { key: "newJersey", label: "New Jersey" },
  { key: "newMexico", label: "New Mexico" },
  { key: "newYork", label: "New York" },
  { key: "northCarolina", label: "North Carolina" },
  { key: "northDakota", label: "North Dakota" },
  { key: "ohio", label: "Ohio" },
  { key: "oklahoma", label: "Oklahoma" },
  { key: "oregon", label: "Oregon" },
  { key: "pennsylvania", label: "Pennsylvania" },
  { key: "rhodeIsland", label: "Rhode Island" },
  { key: "southCarolina", label: "South Carolina" },
  { key: "southDakota", label: "South Dakota" },
  { key: "tennessee", label: "Tennessee" },
  { key: "utah", label: "Utah" },
  { key: "vermont", label: "Vermont" },
  { key: "virginia", label: "Virginia" },
  { key: "washington", label: "Washington" },
  { key: "westVirginia", label: "West Virginia" },
  { key: "wisconsin", label: "Wisconsin" },
  { key: "wyoming", label: "Wyoming" },
  { key: "diplomatic", label: "Diplomatic Plate" },
  { key: "canadian", label: "Canadian Plate" },
  { key: "consular", label: "Consular Plate" },
];

const WILDCARD_POOL_SIZE = 15;
const CHUNK_SIZE = 14; // keeps each Anthropic response comfortably short so it never gets cut off

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const FACT_FIELDS = {
  emoji: { type: "string", description: "A single emoji representing the fact." },
  title: { type: "string", description: "A punchy 3-6 word headline." },
  teaser: { type: "string", description: "One short hook sentence, no more than ~14 words." },
  body: { type: "string", description: "2-3 sentence surprising, true, specific fact. No filler." },
};

function buildKeyedTool(count) {
  return {
    name: "submit_facts",
    description: "Submit the generated facts for this batch of plates.",
    input_schema: {
      type: "object",
      properties: {
        facts: {
          type: "array",
          description: `Exactly ${count} items, in the SAME ORDER as the plate list given — position, not any name field, is how each fact gets matched back to its plate.`,
          items: {
            type: "object",
            properties: FACT_FIELDS,
            required: ["emoji", "title", "teaser", "body"],
          },
        },
      },
      required: ["facts"],
    },
  };
}

function buildPoolTool(count) {
  return {
    name: "submit_facts",
    description: "Submit the generated wildcard fact pool.",
    input_schema: {
      type: "object",
      properties: {
        facts: {
          type: "array",
          description: `Exactly ${count} generic facts, no "key" field needed.`,
          items: { type: "object", properties: FACT_FIELDS, required: ["emoji", "title", "teaser", "body"] },
        },
      },
      required: ["facts"],
    },
  };
}

function buildKeyedPrompt(theme, plates) {
  const numberedList = plates.map((p, i) => `${i + 1}. ${p.label}`).join("\n");
  return `You are writing content for a road-trip license-plate game. Players check off each US state (plus a few bonus "Diplomatic/Canadian/Consular" plates) as they spot it, and a fun fact is revealed each time.

The trip's theme for this session is: "${theme}"

Write ONE fact per plate below, themed around "${theme}" rather than animal facts. Where it fits naturally, tie the fact to the specific state/plate; if no natural connection exists, a general "${theme}" fact is fine instead. No two facts should repeat the same core information.

Plates, in order:
${numberedList}

Tone: punchy, specific, genuinely surprising, and true. Title is a short headline (3-6 words). Teaser is a single-sentence hook (~14 words max). Body is 2-3 sentences of real substance, no filler. Pick one relevant emoji per fact.

Call the submit_facts tool with all ${plates.length} facts as an array, in the exact same order as the numbered list above (item 1 of your array = fact for "${plates[0].label}", and so on). Do not include the plate name in the fact object itself.`;
}

function buildPoolPrompt(theme, count) {
  return `You are writing content for a road-trip license-plate game. Write ${count} distinct, general "${theme}" facts to use as a pool for miscellaneous "wild card" plates that don't map to a specific US state.

Tone: punchy, specific, genuinely surprising, and true. Title is a short headline (3-6 words). Teaser is a single-sentence hook (~14 words max). Body is 2-3 sentences of real substance, no filler. Pick one relevant emoji per fact. No two facts should repeat the same core information.

Call the submit_facts tool with all ${count} facts.`;
}

async function callAnthropic(prompt, tool, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      tools: [tool],
      tool_choice: { type: "tool", name: "submit_facts" },
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const toolUse = (data.content || []).find((block) => block.type === "tool_use");
  if (!toolUse) {
    throw new Error(`Anthropic response had no submit_facts tool call (stop_reason: ${data.stop_reason}).`);
  }
  const facts = toolUse.input?.facts;
  if (!Array.isArray(facts) || facts.length === 0) {
    throw new Error(`Malformed facts payload from Anthropic (stop_reason: ${data.stop_reason}).`);
  }
  return facts;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ ok: false, error: "Edge function is missing required secrets/env vars." }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  let sessionId;

  try {
    const body = await req.json();
    sessionId = body?.session_id;
    const theme = (body?.theme || "").toString().trim();

    if (!sessionId || !theme) {
      return jsonResponse({ ok: false, error: "session_id and theme are required." }, 400);
    }

    const plateChunks = chunk(PLATE_KEYS, CHUNK_SIZE);

    const keyedResults = await Promise.all(
      plateChunks.map((plates) =>
        callAnthropic(buildKeyedPrompt(theme, plates), buildKeyedTool(plates.length), 4000)
      )
    );
    const wildcardPool = await callAnthropic(
      buildPoolPrompt(theme, WILDCARD_POOL_SIZE),
      buildPoolTool(WILDCARD_POOL_SIZE),
      4000
    );

    // Match facts back to plates by position (index within the chunk), not by any name/key
    // the model echoes back — LLMs don't reliably reproduce exact identifier strings verbatim.
    const customFacts = {};
    plateChunks.forEach((plates, chunkIdx) => {
      const facts = keyedResults[chunkIdx] || [];
      plates.forEach((plate, i) => {
        const fact = facts[i];
        if (!fact) return;
        customFacts[plate.key] = [
          { emoji: fact.emoji, title: fact.title, teaser: fact.teaser, body: fact.body },
        ];
      });
    });
    customFacts.wildcard_pool = wildcardPool.map((f) => ({
      emoji: f.emoji,
      title: f.title,
      teaser: f.teaser,
      body: f.body,
    }));

    const missingKeys = PLATE_KEYS.map((p) => p.key).filter((k) => !customFacts[k]);
    if (missingKeys.length > 0) {
      console.warn(`generate-facts: model returned fewer facts than requested in a chunk, will fall back to defaults for: ${missingKeys.join(", ")}`);
    }

    const { error: updateError } = await supabase
      .from("sessions")
      .update({ custom_facts: customFacts, facts_status: "ready" })
      .eq("id", sessionId);

    if (updateError) throw updateError;

    return jsonResponse({
      ok: true,
      generated: Object.keys(customFacts).length - 1,
      wildcard: customFacts.wildcard_pool.length,
    });
  } catch (err) {
    console.error("generate-facts failed:", err);
    if (sessionId) {
      await supabase.from("sessions").update({ facts_status: "error" }).eq("id", sessionId);
    }
    return jsonResponse({ ok: false, error: String(err) }, 500);
  }
});
