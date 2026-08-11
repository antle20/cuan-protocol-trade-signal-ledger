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

// Each asset class can be routed to its own Discord channel via a dedicated
// webhook secret. Classes without one configured (or trades with no
// asset_class, e.g. legacy rows) fall back to DISCORD_WEBHOOK_URL.
const ASSET_CLASS_ENV_VAR: Record<string, string> = {
  Crypto: 'DISCORD_WEBHOOK_URL_CRYPTO',
  Forex: 'DISCORD_WEBHOOK_URL_FOREX',
  Commodities: 'DISCORD_WEBHOOK_URL_COMMODITIES',
  Indices: 'DISCORD_WEBHOOK_URL_INDICES',
};

// Every broadcast pings this role so members get notified of new setups and
// status updates alike.
const DISCORD_ROLE_ID = '1533827234106966127';

const resolveWebhookUrl = (assetClass?: string): string | undefined => {
  const envVar = assetClass ? ASSET_CLASS_ENV_VAR[assetClass] : undefined;
  const specific = envVar ? Deno.env.get(envVar) : undefined;
  return specific || Deno.env.get('DISCORD_WEBHOOK_URL');
};

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

  let embed: unknown;
  let messageId: string | undefined;
  let assetClass: string | undefined;
  try {
    const body = await req.json();
    embed = body.embed;
    messageId = body.messageId;
    assetClass = body.assetClass;
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  if (!embed) {
    return jsonResponse({ error: 'Missing embed' }, 400);
  }

  // Updates to an existing message must go back to whichever webhook posted
  // it, so both create and update calls resolve the URL the same way from
  // the trade's asset class.
  const webhookUrl = resolveWebhookUrl(assetClass);
  if (!webhookUrl) {
    return jsonResponse({ error: 'Discord webhook not configured' }, 500);
  }

  const payload = {
    content: `<@&${DISCORD_ROLE_ID}>`,
    embeds: [embed],
    allowed_mentions: { parse: ['roles'] },
  };

  const postNewMessage = async (): Promise<Response> => {
    const postUrl = new URL(webhookUrl);
    postUrl.searchParams.set('wait', 'true');
    return fetch(postUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  };

  let discordResponse: Response;
  // Set when a PATCH target no longer exists on the resolved webhook (e.g. the
  // asset class's webhook secret was reconfigured after this message was
  // originally posted, so the message lives on a different, now-unreachable
  // webhook) and we fell back to posting a brand-new message instead.
  let recreated = false;

  try {
    if (messageId) {
      const baseUrl = webhookUrl.split('?')[0];
      discordResponse = await fetch(`${baseUrl}/messages/${messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (discordResponse.status === 404) {
        discordResponse = await postNewMessage();
        recreated = true;
      }
    } else {
      discordResponse = await postNewMessage();
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

  return jsonResponse({ id: discordData?.id ?? messageId ?? null, recreated }, 200);
});
