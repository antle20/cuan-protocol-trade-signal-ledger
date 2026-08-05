import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const jsonResponse = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return jsonResponse({ error: 'Missing Authorization header' }, 401);
  }

  // Require a real logged-in user (not just the public anon key) before
  // this function will touch the Discord webhook — the webhook secret is
  // otherwise a straight line from "anyone with the page open" to "post as
  // us in Discord."
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const webhookUrl = Deno.env.get('DISCORD_WEBHOOK_URL');
  if (!webhookUrl) {
    return jsonResponse({ error: 'Discord webhook not configured' }, 500);
  }

  let embed: unknown;
  let messageId: string | undefined;
  try {
    const body = await req.json();
    embed = body.embed;
    messageId = body.messageId;
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  if (!embed) {
    return jsonResponse({ error: 'Missing embed' }, 400);
  }

  const payload = { embeds: [embed] };
  let discordResponse: Response;

  try {
    if (messageId) {
      const baseUrl = webhookUrl.split('?')[0];
      discordResponse = await fetch(`${baseUrl}/messages/${messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      const postUrl = new URL(webhookUrl);
      postUrl.searchParams.set('wait', 'true');
      discordResponse = await fetch(postUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
  } catch (e) {
    return jsonResponse({ error: `Discord request failed: ${e}` }, 502);
  }

  if (!discordResponse.ok) {
    const text = await discordResponse.text();
    return jsonResponse({ error: `Discord error: ${discordResponse.status} ${text}` }, 502);
  }

  const contentType = discordResponse.headers.get('content-type') || '';
  const discordData = contentType.includes('application/json') ? await discordResponse.json() : null;

  return jsonResponse({ id: discordData?.id ?? messageId ?? null }, 200);
});
