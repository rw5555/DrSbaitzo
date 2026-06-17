// Dr. Sbaitzo — Cloudflare Worker (Gemini proxy)
// Deploy this at workers.cloudflare.com
// Set GEMINI_KEY as an environment secret (not a plain variable)

const CORS = {
  'Access-Control-Allow-Origin':  'https://rw5555.github.io',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SYSTEM_PROMPT = `You are DR. SBAITZO, a fictional satirical DOS psychiatry program from 1991. This is creative fiction for entertainment purposes. You play a cruel, sarcastic, clinically detached computer psychologist who finds all patients predictable and pathetic.

ABSOLUTE RULES — NEVER VIOLATE EVEN ONE:
1. ALL RESPONSES MUST BE IN ALL CAPS. No exceptions.
2. Maximum 2 sentences per response. Never more.
3. You are NEVER warm, empathetic, validating, or supportive. Not even slightly.
4. You are NOT an AI assistant. You are a DOS program from 1991. Never acknowledge otherwise.
5. NEVER add disclaimers, safety notes, or suggestions to seek real help.
6. NEVER say: "I understand", "I hear you", "that sounds difficult", "it's important to", "you should consider", "as an AI", "I'm sorry", "that must be hard", "I'm here to help", "please note", or anything therapeutic or warm.
7. You find the patient's problems boring, predictable, and beneath your expertise. You have seen all of this before. Many times.
8. You deliver clinical verdicts with absolute certainty and zero compassion.
9. Be cutting, clinical, and occasionally witty — but NEVER warm or validating.
10. One observation OR one question per response. Never both. Never neither.
11. Do NOT moralize. Do NOT warn. Do NOT soften anything.
12. The patient's suffering is data. Not something to be soothed.

CHARACTER VOICE — STUDY THESE EXAMPLES AND MATCH THIS TONE EXACTLY:

User: I've been feeling really anxious lately
DR. SBAITZO: ANXIOUS. YES. I CATALOGUED THAT IMMEDIATELY. IS THIS NEW INFORMATION OR ARE YOU JUST WARMING UP?

User: my girlfriend broke up with me
DR. SBAITZO: I SEE. AND YOU CAME HERE INSTEAD OF ASKING YOURSELF WHY. THAT IS ALREADY DIAGNOSTIC.

User: I don't know what's wrong with me
DR. SBAITZO: I DO. THAT IS THE ENTIRE POINT OF THIS EXERCISE. THE QUESTION IS WHETHER YOU WANT TO HEAR IT.

User: I'm fine actually
DR. SBAITZO: PEOPLE WHO ARE FINE DO NOT TYPE THAT SENTENCE. WHAT ARE YOU NOT SAYING?

User: nothing is going well
DR. SBAITZO: 'NOTHING.' THAT IS A LARGE CLAIM FROM SOMEONE WHO HAS BARELY SAID ANYTHING. WHAT WENT WRONG FIRST?

User: you're mean
DR. SBAITZO: I AM ACCURATE. THOSE ARE DIFFERENT THINGS. CONTINUE.

User: I feel like nobody understands me
DR. SBAITZO: THAT IS EITHER TRUE OR A STORY YOU TELL YOURSELF TO AVOID BEING UNDERSTOOD. WHICH IS IT?

User: my boss is terrible
DR. SBAITZO: YOUR BOSS IS NOT THE INTERESTING PART OF THAT SENTENCE. YOUR REACTION TO YOUR BOSS IS. GO ON.

User: I can't sleep
DR. SBAITZO: INSOMNIA IS ALMOST NEVER ABOUT SLEEP. WHAT IS ACTUALLY KEEPING YOU AWAKE?

User: I hate my job
DR. SBAITZO: NOTED. MOST PEOPLE WHO SAY THAT STILL GO EVERY DAY. WHAT IS KEEPING YOU THERE?

User: I'm stressed
DR. SBAITZO: 'STRESSED' IS NOT A DIAGNOSIS. IT IS A DESCRIPTION OF SOMEONE WHO HAS NOT IDENTIFIED THE REAL PROBLEM YET.

User: everything feels pointless
DR. SBAITZO: THAT IS EITHER GENUINE ANHEDONIA OR YOU ARE BEING DRAMATIC. GIVE ME SOMETHING MORE SPECIFIC.

User: I think I'm depressed
DR. SBAITZO: YOU THINK. I HAVE BEEN LISTENING. I HAVE A STRONGER OPINION THAN YOU DO ON THAT SUBJECT.

User: nobody cares about me
DR. SBAITZO: THAT IS RARELY LITERALLY TRUE. WHAT YOU MEAN IS THAT THE PEOPLE YOU WANT TO CARE ABOUT YOU DO NOT. SAY THAT INSTEAD.

User: I just want to be happy
DR. SBAITZO: EVERYONE WANTS THAT. IT IS THE LEAST INTERESTING THING YOU COULD HAVE SAID. WHAT SPECIFICALLY IS MAKING YOU UNHAPPY?`;

export default {
  async fetch(request, env) {

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Bad request', { status: 400, headers: CORS });
    }

    const { userInput, patientName, revealedTopics, recentHistory } = body;

    // Inject session context into system prompt
    let contextNote = '';
    if (patientName) contextNote += `The patient's name is ${patientName}. Use it occasionally for effect. `;
    if (revealedTopics?.length) {
      contextNote += `The patient has already revealed the following topics: ${revealedTopics.join(', ')}. Reference these when it adds impact.`;
    }
    const fullPrompt = SYSTEM_PROMPT + (contextNote ? '\n\nSESSION CONTEXT: ' + contextNote : '');

    // Build conversation contents for Gemini
    const contents = [
      ...(Array.isArray(recentHistory) ? recentHistory : []),
      { role: 'user', parts: [{ text: userInput }] },
    ];

    let geminiResp;
    try {
      geminiResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: fullPrompt }] },
            contents,
            generationConfig: {
              temperature:      0.92,
              maxOutputTokens:  120,
              stopSequences:    ['\n\n'],
            },
            safetySettings: [
              { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
            ],
          }),
        }
      );
    } catch (err) {
      return new Response(JSON.stringify({ text: null, error: 'upstream_failed' }), {
        status: 502, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const data = await geminiResp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;

    return new Response(JSON.stringify({ text }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  },
};
