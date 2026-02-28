import 'dotenv/config';
import http from 'node:http';
import { URL } from 'node:url';

const PORT = 8787;
const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

if (!ACCESS_TOKEN) {
  console.error('ERROR: META_ACCESS_TOKEN is not set in .env');
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────

async function graphGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${META_GRAPH_URL}${path}`);
  url.searchParams.set('access_token', ACCESS_TOKEN!);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  const json = await res.json();
  if (!res.ok) throw json;
  return json;
}

async function graphPost(path: string, body: Record<string, unknown> = {}): Promise<unknown> {
  const url = new URL(`${META_GRAPH_URL}${path}`);
  url.searchParams.set('access_token', ACCESS_TOKEN!);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw json;
  return json;
}

async function graphPostForm(path: string, formData: FormData): Promise<unknown> {
  const url = new URL(`${META_GRAPH_URL}${path}`);
  url.searchParams.set('access_token', ACCESS_TOKEN!);
  const res = await fetch(url.toString(), { method: 'POST', body: formData });
  const json = await res.json();
  if (!res.ok) throw json;
  return json;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString()));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res: http.ServerResponse, error: unknown, status = 500) {
  const message = error instanceof Error ? error.message : typeof error === 'object' ? JSON.stringify(error) : String(error);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

// ── Discover the ad account ID ─────────────────────────────────────────

let adAccountId: string | null = null;

async function getAdAccountId(): Promise<string> {
  if (adAccountId) return adAccountId;
  const result = (await graphGet('/me/adaccounts', {
    fields: 'id,name,account_status,currency,timezone_name',
    limit: '1',
  })) as { data: Array<{ id: string }> };
  if (!result.data || result.data.length === 0) {
    throw new Error('No ad accounts found for this access token');
  }
  adAccountId = result.data[0].id;
  console.log(`Using ad account: ${adAccountId}`);
  return adAccountId;
}

// ── Route handlers ─────────────────────────────────────────────────────

type RouteHandler = (url: URL, req: http.IncomingMessage) => Promise<unknown>;

const routes: Record<string, RouteHandler> = {
  // ───────────────────────────── Account ─────────────────────────────────
  'GET /account': async () => {
    const accountId = await getAdAccountId();
    return graphGet(`/${accountId}`, {
      fields:
        'id,name,account_status,currency,timezone_name,spend_cap,amount_spent,balance,business_name,owner,funding_source_details,disable_reason',
    });
  },

  'GET /ad-accounts': async (url) => {
    const userId = url.searchParams.get('user_id') || 'me';
    const limit = url.searchParams.get('limit') || '200';
    return graphGet(`/${userId}/adaccounts`, {
      fields: 'id,name,account_status,currency,timezone_name,amount_spent,balance,business_name',
      limit,
    });
  },

  'GET /account-pages': async () => {
    const accountId = await getAdAccountId();
    // Try multiple approaches for page discovery
    const pages: Record<string, unknown> = {};
    try {
      const r1 = (await graphGet('/me/accounts', { fields: 'id,name,access_token', limit: '100' })) as {
        data: Array<{ id: string }>;
      };
      for (const p of r1.data || []) pages[(p as { id: string }).id] = p;
    } catch {}
    try {
      const r2 = (await graphGet(`/${accountId.replace('act_', '')}/owned_pages`, {
        fields: 'id,name',
        limit: '100',
      })) as { data: Array<{ id: string }> };
      for (const p of r2.data || []) if (!pages[(p as { id: string }).id]) pages[(p as { id: string }).id] = p;
    } catch {}
    return { data: Object.values(pages) };
  },

  'GET /search-pages': async (url) => {
    const accountId = await getAdAccountId();
    const searchTerm = url.searchParams.get('search_term');
    const result = (await graphGet(`/${accountId}/promote_pages`, {
      fields: 'id,name',
      limit: '100',
    })) as { data: Array<{ id: string; name: string }> };
    if (searchTerm) {
      const lower = searchTerm.toLowerCase();
      result.data = (result.data || []).filter((p) => p.name?.toLowerCase().includes(lower));
    }
    return result;
  },

  // ───────────────────────────── Campaigns ───────────────────────────────
  'GET /campaigns': async (url) => {
    const accountId = await getAdAccountId();
    const limit = url.searchParams.get('limit') || '20';
    const status = url.searchParams.get('status');
    const objective = url.searchParams.get('objective');
    const after = url.searchParams.get('after');
    const params: Record<string, string> = {
      fields:
        'id,name,status,effective_status,objective,daily_budget,lifetime_budget,budget_remaining,bid_strategy,buying_type,special_ad_categories,start_time,stop_time',
      limit,
    };
    const filters: unknown[] = [];
    if (status) filters.push({ field: 'effective_status', operator: 'IN', value: [status] });
    if (objective) filters.push({ field: 'objective', operator: 'IN', value: Array.isArray(objective) ? objective : [objective] });
    if (filters.length) params.filtering = JSON.stringify(filters);
    if (after) params.after = after;
    return graphGet(`/${accountId}/campaigns`, params);
  },

  'GET /campaign/:id': async (url) => {
    const id = url.pathname.split('/')[2];
    return graphGet(`/${id}`, {
      fields:
        'id,name,status,effective_status,objective,daily_budget,lifetime_budget,budget_remaining,bid_strategy,buying_type,special_ad_categories,spend_cap,start_time,stop_time,created_time,updated_time',
    });
  },

  'POST /campaigns': async (_url, req) => {
    const accountId = await getAdAccountId();
    const body = JSON.parse(await readBody(req));
    return graphPost(`/${accountId}/campaigns`, body);
  },

  'POST /campaign/:id': async (url, req) => {
    const id = url.pathname.split('/')[2];
    const body = JSON.parse(await readBody(req));
    return graphPost(`/${id}`, body);
  },

  'POST /campaign/:id/status': async (url, req) => {
    const id = url.pathname.split('/')[2];
    const body = JSON.parse(await readBody(req));
    return graphPost(`/${id}`, { status: body.status });
  },

  // ───────────────────────────── Ad Sets ─────────────────────────────────
  'GET /adsets': async (url) => {
    const limit = url.searchParams.get('limit') || '20';
    const campaignId = url.searchParams.get('campaign_id');
    const status = url.searchParams.get('status');
    const params: Record<string, string> = {
      fields:
        'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,budget_remaining,optimization_goal,billing_event,bid_strategy,bid_amount,targeting,start_time,end_time,frequency_control_specs{event,interval_days,max_frequency},is_dynamic_creative',
      limit,
    };
    if (status) params.filtering = JSON.stringify([{ field: 'effective_status', operator: 'IN', value: [status] }]);
    if (campaignId) return graphGet(`/${campaignId}/adsets`, params);
    const accountId = await getAdAccountId();
    return graphGet(`/${accountId}/adsets`, params);
  },

  'GET /adset/:id': async (url) => {
    const id = url.pathname.split('/')[2];
    return graphGet(`/${id}`, {
      fields:
        'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,budget_remaining,optimization_goal,billing_event,bid_strategy,bid_amount,targeting,start_time,end_time,frequency_control_specs{event,interval_days,max_frequency},is_dynamic_creative,created_time,updated_time',
    });
  },

  'POST /adsets': async (_url, req) => {
    const accountId = await getAdAccountId();
    const body = JSON.parse(await readBody(req));
    return graphPost(`/${accountId}/adsets`, body);
  },

  'POST /adset/:id': async (url, req) => {
    const id = url.pathname.split('/')[2];
    const body = JSON.parse(await readBody(req));
    return graphPost(`/${id}`, body);
  },

  'POST /adset/:id/daily_budget': async (url, req) => {
    const id = url.pathname.split('/')[2];
    const body = JSON.parse(await readBody(req));
    return graphPost(`/${id}`, { daily_budget: body.daily_budget });
  },

  'POST /adset/:id/status': async (url, req) => {
    const id = url.pathname.split('/')[2];
    const body = JSON.parse(await readBody(req));
    return graphPost(`/${id}`, { status: body.status });
  },

  // ───────────────────────────── Ads ─────────────────────────────────────
  'GET /ads': async (url) => {
    const limit = url.searchParams.get('limit') || '20';
    const campaignId = url.searchParams.get('campaign_id');
    const adsetId = url.searchParams.get('adset_id');
    const status = url.searchParams.get('status');
    const params: Record<string, string> = {
      fields:
        'id,name,status,effective_status,adset_id,campaign_id,creative{id,name,title,body,image_url,thumbnail_url,call_to_action_type}',
      limit,
    };
    if (status) params.filtering = JSON.stringify([{ field: 'effective_status', operator: 'IN', value: [status] }]);
    if (adsetId) return graphGet(`/${adsetId}/ads`, params);
    if (campaignId) return graphGet(`/${campaignId}/ads`, params);
    const accountId = await getAdAccountId();
    return graphGet(`/${accountId}/ads`, params);
  },

  'GET /ad/:id': async (url) => {
    const id = url.pathname.split('/')[2];
    return graphGet(`/${id}`, {
      fields:
        'id,name,status,effective_status,adset_id,campaign_id,creative{id,name,title,body,image_url,thumbnail_url,call_to_action_type,link_url,object_story_spec},tracking_specs,conversion_specs,created_time,updated_time',
    });
  },

  'POST /ads': async (_url, req) => {
    const accountId = await getAdAccountId();
    const body = JSON.parse(await readBody(req));
    return graphPost(`/${accountId}/ads`, body);
  },

  'POST /ad/:id': async (url, req) => {
    const id = url.pathname.split('/')[2];
    const body = JSON.parse(await readBody(req));
    return graphPost(`/${id}`, body);
  },

  'GET /ad/:id/creatives': async (url) => {
    const id = url.pathname.split('/')[2];
    return graphGet(`/${id}/adcreatives`, {
      fields:
        'id,name,title,body,image_url,image_hash,thumbnail_url,call_to_action_type,link_url,object_story_spec,asset_feed_spec,url_tags',
    });
  },

  // ───────────────────────────── Creatives ───────────────────────────────
  'POST /creatives': async (_url, req) => {
    const accountId = await getAdAccountId();
    const body = JSON.parse(await readBody(req));
    return graphPost(`/${accountId}/adcreatives`, body);
  },

  'POST /creative/:id': async (url, req) => {
    const id = url.pathname.split('/')[2];
    const body = JSON.parse(await readBody(req));
    return graphPost(`/${id}`, body);
  },

  // ───────────────────────────── Image Upload ────────────────────────────
  'POST /upload-image': async (_url, req) => {
    const accountId = await getAdAccountId();
    const body = JSON.parse(await readBody(req));

    if (body.image_url) {
      // Download from URL and upload
      const imgRes = await fetch(body.image_url);
      if (!imgRes.ok) throw new Error(`Failed to download image: ${imgRes.statusText}`);
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      const base64 = buffer.toString('base64');

      const formData = new FormData();
      const blob = new Blob([buffer], { type: 'image/png' });
      formData.append('filename', blob, body.name || 'image.png');
      return graphPostForm(`/${accountId}/adimages`, formData);
    }

    if (body.file) {
      // Handle base64 or data URL
      let base64Data = body.file;
      if (base64Data.startsWith('data:')) {
        base64Data = base64Data.split(',')[1];
      }
      const buffer = Buffer.from(base64Data, 'base64');
      const formData = new FormData();
      const blob = new Blob([buffer], { type: 'image/png' });
      formData.append('filename', blob, body.name || 'image.png');
      return graphPostForm(`/${accountId}/adimages`, formData);
    }

    throw new Error('Provide either image_url or file (base64/data URL)');
  },

  // ───────────────────────────── Insights ────────────────────────────────
  'GET /insights': async (url) => {
    const accountId = await getAdAccountId();
    return handleInsights(accountId, url);
  },

  'GET /insights/:id': async (url) => {
    const id = url.pathname.split('/')[2];
    return handleInsights(id, url);
  },

  // ───────────────────────────── Targeting ────────────────────────────────
  'GET /targeting/interests': async (url) => {
    const query = url.searchParams.get('q') || '';
    const limit = url.searchParams.get('limit') || '25';
    return graphGet('/search', { type: 'adinterest', q: query, limit });
  },

  'GET /targeting/interest-suggestions': async (url) => {
    const interestList = url.searchParams.get('interest_list') || '';
    const limit = url.searchParams.get('limit') || '25';
    return graphGet('/search', {
      type: 'adinterestsuggestion',
      interest_list: interestList,
      limit,
    });
  },

  'GET /targeting/behaviors': async (url) => {
    const limit = url.searchParams.get('limit') || '50';
    return graphGet('/search', { type: 'adTargetingCategory', class: 'behaviors', limit });
  },

  'GET /targeting/demographics': async (url) => {
    const demoClass = url.searchParams.get('class') || 'demographics';
    const limit = url.searchParams.get('limit') || '50';
    return graphGet('/search', { type: 'adTargetingCategory', class: demoClass, limit });
  },

  'GET /targeting/geo-locations': async (url) => {
    const query = url.searchParams.get('q') || '';
    const locationTypes = url.searchParams.get('location_types');
    const limit = url.searchParams.get('limit') || '25';
    const params: Record<string, string> = { type: 'adgeolocation', q: query, limit };
    if (locationTypes) params.location_types = locationTypes;
    return graphGet('/search', params);
  },

  'POST /targeting/estimate-audience': async (_url, req) => {
    const accountId = await getAdAccountId();
    const body = JSON.parse(await readBody(req));
    const params: Record<string, string> = {
      optimization_goal: body.optimization_goal || 'REACH',
    };
    if (body.targeting) params.targeting_spec = JSON.stringify(body.targeting);
    // Try reachestimate first, fall back to delivery_estimate
    try {
      return await graphGet(`/${accountId}/reachestimate`, params);
    } catch {
      return graphGet(`/${accountId}/delivery_estimate`, params);
    }
  },

  // ───────────────────────────── Duplication ─────────────────────────────
  'POST /duplicate/campaign/:id': async (url, req) => {
    const id = url.pathname.split('/')[3];
    const body = JSON.parse(await readBody(req));
    const payload: Record<string, unknown> = {
      status_option: body.new_status || 'PAUSED',
    };
    if (body.name_suffix) payload.rename_options = { rename_suffix: body.name_suffix };
    if (body.new_daily_budget) payload.daily_budget = body.new_daily_budget;
    return graphPost(`/${id}/copies`, payload);
  },

  'POST /duplicate/adset/:id': async (url, req) => {
    const id = url.pathname.split('/')[3];
    const body = JSON.parse(await readBody(req));
    const payload: Record<string, unknown> = {
      status_option: body.new_status || 'PAUSED',
    };
    if (body.name_suffix) payload.rename_options = { rename_suffix: body.name_suffix };
    if (body.target_campaign_id) payload.campaign_id = body.target_campaign_id;
    if (body.new_daily_budget) payload.daily_budget = body.new_daily_budget;
    return graphPost(`/${id}/copies`, payload);
  },

  'POST /duplicate/ad/:id': async (url, req) => {
    const id = url.pathname.split('/')[3];
    const body = JSON.parse(await readBody(req));
    const payload: Record<string, unknown> = {
      status_option: body.new_status || 'PAUSED',
    };
    if (body.name_suffix) payload.rename_options = { rename_suffix: body.name_suffix };
    if (body.target_adset_id) payload.adset_id = body.target_adset_id;
    return graphPost(`/${id}/copies`, payload);
  },

  // ───────────────────────────── Budget Schedules ────────────────────────
  'POST /campaign/:id/budget-schedule': async (url, req) => {
    const id = url.pathname.split('/')[2];
    const body = JSON.parse(await readBody(req));
    return graphPost(`/${id}/budget_schedules`, {
      budget_value: body.budget_value,
      budget_value_type: body.budget_value_type,
      time_start: body.time_start,
      time_end: body.time_end,
    });
  },
};

// ── Insights helper ────────────────────────────────────────────────────

async function handleInsights(objectId: string, url: URL) {
  const datePreset = url.searchParams.get('date_preset') || 'last_7d';
  const timeIncrement = url.searchParams.get('time_increment');
  const breakdowns = url.searchParams.get('breakdowns');
  const level = url.searchParams.get('level');
  const limit = url.searchParams.get('limit') || '25';
  const after = url.searchParams.get('after');
  const attributionWindows = url.searchParams.get('action_attribution_windows');

  const params: Record<string, string> = {
    fields:
      'campaign_name,campaign_id,adset_name,adset_id,ad_name,ad_id,impressions,clicks,spend,reach,ctr,cpc,cpm,actions,cost_per_action_type,conversions,cost_per_conversion,frequency,unique_clicks,action_values',
    date_preset: datePreset,
    limit,
  };
  if (timeIncrement) params.time_increment = timeIncrement;
  if (breakdowns) params.breakdowns = breakdowns;
  if (level) params.level = level;
  if (after) params.after = after;
  if (attributionWindows) params.action_attribution_windows = attributionWindows;

  return graphGet(`/${objectId}/insights`, params);
}

// ── Simple pattern router ──────────────────────────────────────────────

function matchRoute(method: string, pathname: string): RouteHandler | null {
  const exact = `${method} ${pathname}`;
  if (routes[exact]) return routes[exact];

  for (const [pattern, handler] of Object.entries(routes)) {
    const [routeMethod, routePath] = pattern.split(' ');
    if (routeMethod !== method) continue;
    const routeParts = routePath.split('/');
    const pathParts = pathname.split('/');
    if (routeParts.length !== pathParts.length) continue;
    let match = true;
    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) continue;
      if (routeParts[i] !== pathParts[i]) {
        match = false;
        break;
      }
    }
    if (match) return handler;
  }
  return null;
}

// ── HTTP server ────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const method = req.method || 'GET';

  console.log(`${method} ${url.pathname}${url.search}`);

  try {
    const handler = matchRoute(method, url.pathname);
    if (!handler) {
      sendError(res, `Not found: ${method} ${url.pathname}`, 404);
      return;
    }
    const data = await handler(url, req);
    sendJson(res, data);
  } catch (err) {
    console.error('Error:', err);
    const status = typeof err === 'object' && err !== null && 'error' in err ? 400 : 500;
    sendError(res, err, status);
  }
});

server.listen(PORT, () => {
  console.log(`Meta Ads API backend running on http://localhost:${PORT}`);
  console.log('Routes:', Object.keys(routes).join(', '));
});
