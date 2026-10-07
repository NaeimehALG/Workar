process.env.SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://jgbjhzhbdsdhssyakpgq.supabase.co').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, ''); // tolerate a URL saved with /rest/v1
// Paste into index.html, replacing your current natural-voice function.
// "supabase" = the Supabase client variable already in your index.html
// (rename if yours is called something else, e.g. sb or supabaseClient).

async function speakNatural(text) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");

  const res = await fetch("/api/tts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${await res.text()}`);
  }

  const blob = await res.blob();
  const audio = new Audio(URL.createObjectURL(blob));
  await audio.play();
}
