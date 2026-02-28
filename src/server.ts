import 'dotenv/config';
import { z } from 'zod';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ── Configuration ──────────────────────────────────────────────────────
const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1_000;

if (!ACCESS_TOKEN) {
  process.stderr.write('ERROR: META_ACCESS_TOKEN is not set in .env\n');
  process.exit(1);
}

// ── Logging (stderr so it doesn't interfere with stdio transport) ──────
function log(level: 'info' | 'warn' | 'error', message: string, data?: unknown) {
  const entry = { ts: new Date().toISOString(), level, message, ...(data !== undefined ? { data } : {}) };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

// ── Meta Graph API client (direct — no backend needed) ─────────────────
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function graphRequest(method: 'GET' | 'POST', path: string, params?: Record<string, string>, body?: Record<string, unknown>, retries = MAX_RETRIES): Promise<unknown> {
  const url = new URL(`${META_GRAPH_URL}${path}`);
  url.searchParams.set('access_token', ACCESS_TOKEN!);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
  }

  const init: RequestInit = { method };
  if (body !== undefined) {
    // Meta Graph API expects form-encoded params where nested objects are JSON-stringified
    const formParams = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || v === null) continue;
      formParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    init.headers = { 'content-type': 'application/x-www-form-urlencoded' };
    init.body = formParams.toString();
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url.toString(), init);
      const json = await res.json();
      if (!res.ok) {
        const errObj = typeof json === 'object' && json !== null && 'error' in json
          ? (json as { error: { message: string; error_subcode?: number; error_user_title?: string; error_user_msg?: string; fbtrace_id?: string } }).error
          : null;
        const errDetail = errObj
          ? `${errObj.message}${errObj.error_user_msg ? ' | ' + errObj.error_user_msg : ''}${errObj.error_subcode ? ' (subcode: ' + errObj.error_subcode + ')' : ''}`
          : `HTTP ${res.status}: ${JSON.stringify(json)}`;
        log('error', `Meta API error on ${method} ${path}`, { status: res.status, error: json });
        if (res.status >= 400 && res.status < 500) throw new ApiError(errDetail, res.status);
        if (attempt < retries) {
          log('warn', `Meta API ${res.status} on ${method} ${path}, retrying`, { attempt: attempt + 1 });
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        throw new ApiError(errDetail, res.status);
      }
      return json;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ApiError(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`, 408);
      }
      if (attempt < retries) {
        log('warn', `Network error on ${method} ${path}, retrying`, { attempt: attempt + 1, error: String(err) });
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      throw new ApiError(`Network error: ${err instanceof Error ? err.message : String(err)}`, 0);
    }
  }
  throw new ApiError('Max retries exceeded', 0);
}

function graphGet(path: string, params?: Record<string, string>) {
  return graphRequest('GET', path, params);
}
function graphPost(path: string, body: Record<string, unknown>) {
  return graphRequest('POST', path, undefined, body);
}

class ApiError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'ApiError';
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Ad Account auto-discovery ──────────────────────────────────────────
let cachedAccountId: string | null = null;

async function getAccountId(): Promise<string> {
  if (cachedAccountId) return cachedAccountId;
  const result = (await graphGet('/me/adaccounts', {
    fields: 'id,name,account_status',
    limit: '1',
  })) as { data: Array<{ id: string }> };
  if (!result.data?.length) throw new ApiError('No ad accounts found for this access token', 403);
  cachedAccountId = result.data[0].id;
  log('info', `Using ad account: ${cachedAccountId}`);
  return cachedAccountId;
}

// ── Response helpers ───────────────────────────────────────────────────
function success(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

function buildParams(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') {
      out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  }
  return out;
}

// ── Reporting helpers ─────────────────────────────────────────────────
const REDUNDANT_ACTION_PREFIXES = [
  'omni_', 'onsite_web_app_', 'onsite_web_', 'onsite_app_',
  'web_app_in_store_', 'offsite_conversion.fb_pixel_',
];

function stripRedundantActions(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.data)) {
    obj.data = obj.data.map((row: unknown) => {
      if (!row || typeof row !== 'object') return row;
      const r = row as Record<string, unknown>;
      for (const field of ['actions', 'action_values', 'cost_per_action_type', 'conversions']) {
        if (Array.isArray(r[field])) {
          r[field] = (r[field] as Array<Record<string, unknown>>).filter(
            (a) => !REDUNDANT_ACTION_PREFIXES.some((p) => String(a.action_type || '').startsWith(p))
          );
        }
      }
      return r;
    });
  }
  return obj;
}

function getActionValue(actions: unknown[] | undefined, actionType: string): number {
  if (!Array.isArray(actions)) return 0;
  const found = actions.find((a: unknown) => (a as Record<string, unknown>).action_type === actionType) as Record<string, unknown> | undefined;
  return found ? parseFloat(String(found.value || '0')) : 0;
}

function calcDerivedMetrics(row: Record<string, unknown>): Record<string, unknown> {
  const spend = parseFloat(String(row.spend || '0'));
  const impressions = parseInt(String(row.impressions || '0'), 10);
  const clicks = parseInt(String(row.clicks || '0'), 10);
  const reach = parseInt(String(row.reach || '0'), 10);
  const ctr = parseFloat(String(row.ctr || '0'));
  const cpc = parseFloat(String(row.cpc || '0'));
  const cpm = parseFloat(String(row.cpm || '0'));
  const frequency = parseFloat(String(row.frequency || '0'));
  const uniqueClicks = parseInt(String(row.unique_clicks || '0'), 10);

  const actions = row.actions as Array<Record<string, unknown>> | undefined;
  const actionValues = row.action_values as Array<Record<string, unknown>> | undefined;

  const purchases = getActionValue(actions, 'purchase');
  const addToCarts = getActionValue(actions, 'add_to_cart');
  const initiateCheckouts = getActionValue(actions, 'initiate_checkout');
  const viewContents = getActionValue(actions, 'view_content');
  const leads = getActionValue(actions, 'lead');
  const revenue = getActionValue(actionValues, 'purchase');

  const roas = spend > 0 ? Math.round((revenue / spend) * 100) / 100 : 0;
  const cpa = purchases > 0 ? Math.round((spend / purchases) * 100) / 100 : 0;
  const costPerATC = addToCarts > 0 ? Math.round((spend / addToCarts) * 100) / 100 : 0;

  return {
    spend: Math.round(spend * 100) / 100,
    impressions, clicks, reach,
    frequency: Math.round(frequency * 100) / 100,
    ctr: Math.round(ctr * 100) / 100,
    cpc: Math.round(cpc * 100) / 100,
    cpm: Math.round(cpm * 100) / 100,
    unique_clicks: uniqueClicks,
    purchases, revenue: Math.round(revenue * 100) / 100, roas, cpa,
    add_to_carts: addToCarts, cost_per_atc: costPerATC,
    initiate_checkouts: initiateCheckouts,
    view_contents: viewContents,
    leads,
  };
}

function pctChange(current: number, previous: number): { delta: string; pct: string } {
  const d = current - previous;
  const sign = d >= 0 ? '+' : '';
  const pct = previous !== 0 ? Math.round((d / previous) * 1000) / 10 : (current > 0 ? 100 : 0);
  return { delta: `${sign}${Math.round(d * 100) / 100}`, pct: `${sign}${pct}%` };
}

function resolveDateRange(timeRange: string | { since: string; until: string }): { since: string; until: string } {
  if (typeof timeRange === 'object') return timeRange;
  const today = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  switch (timeRange) {
    case 'today': return { since: fmt(today), until: fmt(today) };
    case 'yesterday': { const d = new Date(today); d.setDate(d.getDate() - 1); return { since: fmt(d), until: fmt(d) }; }
    case 'this_week': {
      const dow = today.getDay();
      const mon = new Date(today); mon.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
      return { since: fmt(mon), until: fmt(today) };
    }
    case 'last_week': {
      const dow = today.getDay();
      const mon = new Date(today); mon.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1) - 7);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      return { since: fmt(mon), until: fmt(sun) };
    }
    case 'this_month': {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      return { since: fmt(first), until: fmt(today) };
    }
    case 'last_month': {
      const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const last = new Date(today.getFullYear(), today.getMonth(), 0);
      return { since: fmt(first), until: fmt(last) };
    }
    default: {
      // last_Nd format
      const match = timeRange.match(/^last_(\d+)d$/);
      const days = match ? parseInt(match[1], 10) : 7;
      const until = new Date(today); until.setDate(until.getDate() - 1);
      const since = new Date(until); since.setDate(since.getDate() - days + 1);
      return { since: fmt(since), until: fmt(until) };
    }
  }
}

function getPreviousPeriod(since: string, until: string): { since: string; until: string } {
  const s = new Date(since);
  const u = new Date(until);
  const days = Math.round((u.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  const prevUntil = new Date(s);
  prevUntil.setDate(prevUntil.getDate() - 1);
  const prevSince = new Date(prevUntil);
  prevSince.setDate(prevSince.getDate() - days + 1);
  return { since: prevSince.toISOString().slice(0, 10), until: prevUntil.toISOString().slice(0, 10) };
}

// ── Tool definitions ───────────────────────────────────────────────────
interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  zodSchema: z.ZodType<any>;
  handler: (args: Record<string, unknown>) => Promise<ReturnType<typeof success>>;
}

const statusEnum = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
const datePresetEnum = [
  'today', 'yesterday', 'last_3d', 'last_7d', 'last_14d',
  'last_28d', 'last_30d', 'last_90d', 'this_month', 'last_month',
] as const;
const breakdownEnum = ['device_platform', 'age', 'gender', 'country', 'publisher_platform', 'platform_position', 'region', 'dma', 'impression_device'] as const;
const objectiveEnum = [
  'OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT',
  'OUTCOME_LEADS', 'OUTCOME_SALES', 'OUTCOME_APP_PROMOTION',
] as const;

const CAMPAIGN_FIELDS = 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,budget_remaining,bid_strategy,buying_type,special_ad_categories,spend_cap,start_time,stop_time,created_time,updated_time';
const ADSET_FIELDS = 'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,budget_remaining,optimization_goal,billing_event,bid_strategy,bid_amount,targeting,start_time,end_time,frequency_control_specs{event,interval_days,max_frequency},is_dynamic_creative,created_time,updated_time';
const AD_FIELDS = 'id,name,status,effective_status,adset_id,campaign_id,creative{id,name,title,body,image_url,thumbnail_url,call_to_action_type,link_url},tracking_specs,created_time,updated_time';
const INSIGHT_FIELDS = 'campaign_name,campaign_id,adset_name,adset_id,ad_name,ad_id,impressions,clicks,spend,reach,ctr,cpc,cpm,actions,cost_per_action_type,conversions,cost_per_conversion,frequency,unique_clicks,action_values';

const tools: ToolDef[] = [
  // ═══════════════════════════ ACCOUNT ═══════════════════════════════════
  {
    name: 'get_account_info',
    description: 'Get account-level information including name, currency, timezone, spend cap, and account status.',
    inputSchema: { type: 'object', properties: {} },
    zodSchema: z.object({}),
    async handler() {
      const id = await getAccountId();
      return success(await graphGet(`/${id}`, {
        fields: 'id,name,account_status,currency,timezone_name,spend_cap,amount_spent,balance,business_name,owner,disable_reason',
      }));
    },
  },
  {
    name: 'get_ad_accounts',
    description: 'Get ad accounts accessible by the current user.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max accounts to return (default: 200)' } },
    },
    zodSchema: z.object({ limit: z.number().optional() }),
    async handler(args) {
      const { limit = 200 } = this.zodSchema.parse(args);
      return success(await graphGet('/me/adaccounts', {
        fields: 'id,name,account_status,currency,timezone_name,amount_spent,balance,business_name',
        limit: String(limit),
      }));
    },
  },
  {
    name: 'get_account_pages',
    description: 'Get Facebook Pages associated with the ad account. Useful for finding page_id when creating creatives.',
    inputSchema: { type: 'object', properties: {} },
    zodSchema: z.object({}),
    async handler() {
      const pages: Record<string, unknown> = {};
      try {
        const r = (await graphGet('/me/accounts', { fields: 'id,name', limit: '100' })) as { data: Array<{ id: string }> };
        for (const p of r.data || []) pages[(p as { id: string }).id] = p;
      } catch {}
      return success({ data: Object.values(pages) });
    },
  },
  {
    name: 'search_pages_by_name',
    description: 'Search for Pages by name within the account.',
    inputSchema: {
      type: 'object',
      properties: { search_term: { type: 'string', description: 'Page name to search for (optional)' } },
    },
    zodSchema: z.object({ search_term: z.string().optional() }),
    async handler(args) {
      const { search_term } = this.zodSchema.parse(args);
      const id = await getAccountId();
      const result = (await graphGet(`/${id}/promote_pages`, { fields: 'id,name', limit: '100' })) as { data: Array<{ id: string; name: string }> };
      if (search_term) {
        const lower = search_term.toLowerCase();
        result.data = (result.data || []).filter((p) => p.name?.toLowerCase().includes(lower));
      }
      return success(result);
    },
  },

  // ═══════════════════════════ CAMPAIGNS ═════════════════════════════════
  {
    name: 'list_campaigns',
    description: 'List Meta ad campaigns. Returns id, name, status, objective, and budget info.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max campaigns to return (1-100, default 20)' },
        status: { type: 'string', enum: [...statusEnum], description: 'Filter by status' },
        objective: { type: 'string', enum: [...objectiveEnum], description: 'Filter by objective' },
        after: { type: 'string', description: 'Pagination cursor' },
      },
    },
    zodSchema: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      status: z.enum(statusEnum).optional(),
      objective: z.enum(objectiveEnum).optional(),
      after: z.string().optional(),
    }),
    async handler(args) {
      const { limit = 20, status, objective, after } = this.zodSchema.parse(args);
      const id = await getAccountId();
      const filters: unknown[] = [];
      if (status) filters.push({ field: 'effective_status', operator: 'IN', value: [status] });
      if (objective) filters.push({ field: 'objective', operator: 'IN', value: [objective] });
      const params: Record<string, string> = { fields: CAMPAIGN_FIELDS, limit: String(limit) };
      if (filters.length) params.filtering = JSON.stringify(filters);
      if (after) params.after = after;
      return success(await graphGet(`/${id}/campaigns`, params));
    },
  },
  {
    name: 'get_campaign_details',
    description: 'Get detailed information about a specific campaign including settings, budget, bid strategy, and schedule.',
    inputSchema: { type: 'object', properties: { campaign_id: { type: 'string' } }, required: ['campaign_id'] },
    zodSchema: z.object({ campaign_id: z.string().min(1) }),
    async handler(args) {
      const { campaign_id } = this.zodSchema.parse(args);
      return success(await graphGet(`/${campaign_id}`, { fields: CAMPAIGN_FIELDS }));
    },
  },
  {
    name: 'create_campaign',
    description: 'Create a new campaign. Objectives must be ODAX: OUTCOME_AWARENESS, OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT, OUTCOME_LEADS, OUTCOME_SALES, OUTCOME_APP_PROMOTION. Set daily_budget or lifetime_budget for campaign-level budget (CBO). Omit both and set use_adset_level_budgets=true for adset-level budgets.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        objective: { type: 'string', enum: [...objectiveEnum] },
        status: { type: 'string', enum: [...statusEnum], description: 'Default: PAUSED' },
        daily_budget: { type: 'string', description: 'Daily budget in cents (e.g. "5000" = $50). Sets campaign-level budget (CBO).' },
        lifetime_budget: { type: 'string', description: 'Lifetime budget in cents. Sets campaign-level budget (CBO).' },
        bid_strategy: { type: 'string' },
        special_ad_categories: { type: 'array', items: { type: 'string' } },
        use_adset_level_budgets: { type: 'boolean', description: 'Set true to use ad set level budgets instead of campaign budget. Do not set daily_budget/lifetime_budget when true.' },
        spend_cap: { type: 'string', description: 'Spending limit for the campaign in cents' },
      },
      required: ['name', 'objective'],
    },
    zodSchema: z.object({
      name: z.string().min(1), objective: z.enum(objectiveEnum),
      status: z.string().optional(), daily_budget: z.string().optional(),
      lifetime_budget: z.string().optional(), bid_strategy: z.string().optional(),
      special_ad_categories: z.array(z.string()).optional(),
      use_adset_level_budgets: z.boolean().optional(),
      spend_cap: z.string().optional(),
    }),
    async handler(args) {
      const parsed = this.zodSchema.parse(args);
      const id = await getAccountId();
      const { use_adset_level_budgets, ...rest } = parsed;
      const body: Record<string, unknown> = { ...rest };
      if (!body.status) body.status = 'PAUSED';
      if (!body.special_ad_categories) body.special_ad_categories = [];
      // If no campaign budget set, configure for adset-level budgets
      if (!body.daily_budget && !body.lifetime_budget) {
        // Meta requires explicit budget sharing flag + bid strategy for adset-level budgets
        body.is_adset_budget_sharing_enabled = use_adset_level_budgets !== false;
        if (!body.bid_strategy) body.bid_strategy = 'LOWEST_COST_WITHOUT_CAP';
      }
      return success(await graphPost(`/${id}/campaigns`, body));
    },
  },
  {
    name: 'update_campaign',
    description: 'Update a campaign (name, status, budget, bid strategy, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' }, name: { type: 'string' },
        status: { type: 'string', enum: [...statusEnum] },
        daily_budget: { type: 'string' }, lifetime_budget: { type: 'string' },
        bid_strategy: { type: 'string' }, spend_cap: { type: 'string' },
      },
      required: ['campaign_id'],
    },
    zodSchema: z.object({
      campaign_id: z.string().min(1), name: z.string().optional(),
      status: z.enum(statusEnum).optional(), daily_budget: z.string().optional(),
      lifetime_budget: z.string().optional(), bid_strategy: z.string().optional(),
      spend_cap: z.string().optional(),
    }),
    async handler(args) {
      const { campaign_id, ...updates } = this.zodSchema.parse(args);
      const body = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
      return success(await graphPost(`/${campaign_id}`, body));
    },
  },
  {
    name: 'pause_campaign',
    description: 'Pause an active campaign.',
    inputSchema: { type: 'object', properties: { campaign_id: { type: 'string' } }, required: ['campaign_id'] },
    zodSchema: z.object({ campaign_id: z.string().min(1) }),
    async handler(args) {
      const { campaign_id } = this.zodSchema.parse(args);
      return success(await graphPost(`/${campaign_id}`, { status: 'PAUSED' }));
    },
  },
  {
    name: 'enable_campaign',
    description: 'Enable (activate) a paused campaign.',
    inputSchema: { type: 'object', properties: { campaign_id: { type: 'string' } }, required: ['campaign_id'] },
    zodSchema: z.object({ campaign_id: z.string().min(1) }),
    async handler(args) {
      const { campaign_id } = this.zodSchema.parse(args);
      return success(await graphPost(`/${campaign_id}`, { status: 'ACTIVE' }));
    },
  },

  // ═══════════════════════════ AD SETS ═══════════════════════════════════
  {
    name: 'list_adsets',
    description: 'List ad sets, optionally filtered by campaign.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Filter by campaign ID' },
        limit: { type: 'number', description: 'Max results (1-100, default 20)' },
        status: { type: 'string', enum: [...statusEnum] },
      },
    },
    zodSchema: z.object({ campaign_id: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), status: z.enum(statusEnum).optional() }),
    async handler(args) {
      const { campaign_id, limit = 20, status } = this.zodSchema.parse(args);
      const parent = campaign_id || await getAccountId();
      const params: Record<string, string> = { fields: ADSET_FIELDS, limit: String(limit) };
      if (status) params.filtering = JSON.stringify([{ field: 'effective_status', operator: 'IN', value: [status] }]);
      return success(await graphGet(`/${parent}/adsets`, params));
    },
  },
  {
    name: 'get_adset_details',
    description: 'Get detailed ad set info including targeting, budget, frequency caps, bid strategy.',
    inputSchema: { type: 'object', properties: { adset_id: { type: 'string' } }, required: ['adset_id'] },
    zodSchema: z.object({ adset_id: z.string().min(1) }),
    async handler(args) {
      const { adset_id } = this.zodSchema.parse(args);
      return success(await graphGet(`/${adset_id}`, { fields: ADSET_FIELDS }));
    },
  },
  {
    name: 'create_adset',
    description: 'Create a new ad set. Requires campaign_id, name, optimization_goal, billing_event. For OUTCOME_SALES campaigns with OFFSITE_CONVERSIONS, you must provide promoted_object with pixel_id and custom_event_type (e.g. PURCHASE). For lead gen, set destination_type to ON_AD.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' }, name: { type: 'string' },
        optimization_goal: { type: 'string', description: 'e.g. LINK_CLICKS, REACH, OFFSITE_CONVERSIONS' },
        billing_event: { type: 'string', description: 'e.g. IMPRESSIONS, LINK_CLICKS' },
        status: { type: 'string', enum: [...statusEnum] },
        daily_budget: { type: 'string', description: 'In cents' },
        lifetime_budget: { type: 'string' },
        bid_amount: { type: 'number' }, bid_strategy: { type: 'string' },
        targeting: { type: 'object', description: 'Targeting spec (geo, age, gender, interests, etc.). Example: {"geo_locations":{"countries":["AU"]},"age_min":18,"age_max":65}' },
        promoted_object: { type: 'object', description: 'Required for conversion campaigns. Example: {"pixel_id":"123","custom_event_type":"PURCHASE"} or {"page_id":"123"} or {"application_id":"123","object_store_url":"https://..."}' },
        destination_type: { type: 'string', description: 'Where users go after clicking. e.g. WEBSITE, APP_STORE, ON_AD (for lead gen)' },
        start_time: { type: 'string' }, end_time: { type: 'string' },
        is_dynamic_creative: { type: 'boolean' },
        frequency_control_specs: { type: 'array' },
        dsa_beneficiary: { type: 'string', description: 'DSA beneficiary for European compliance' },
      },
      required: ['campaign_id', 'name', 'optimization_goal', 'billing_event'],
    },
    zodSchema: z.object({
      campaign_id: z.string().min(1), name: z.string().min(1),
      optimization_goal: z.string(), billing_event: z.string(),
      status: z.string().optional(), daily_budget: z.string().optional(),
      lifetime_budget: z.string().optional(), bid_amount: z.number().optional(),
      bid_strategy: z.string().optional(), targeting: z.record(z.string(), z.unknown()).optional(),
      promoted_object: z.record(z.string(), z.unknown()).optional(),
      destination_type: z.string().optional(),
      start_time: z.string().optional(), end_time: z.string().optional(),
      is_dynamic_creative: z.boolean().optional(),
      frequency_control_specs: z.array(z.record(z.string(), z.unknown())).optional(),
      dsa_beneficiary: z.string().optional(),
    }),
    async handler(args) {
      const parsed = this.zodSchema.parse(args);
      const id = await getAccountId();
      const body: Record<string, unknown> = { ...parsed };
      if (!body.status) body.status = 'PAUSED';
      return success(await graphPost(`/${id}/adsets`, body));
    },
  },
  {
    name: 'update_adset',
    description: 'Update an ad set (status, budget, targeting, bid strategy, etc.). Note: frequency_control_specs cannot be changed after creation.',
    inputSchema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string' }, name: { type: 'string' },
        status: { type: 'string', enum: [...statusEnum] },
        daily_budget: { type: 'string' }, lifetime_budget: { type: 'string' },
        bid_amount: { type: 'number' }, bid_strategy: { type: 'string' },
        targeting: { type: 'object', description: 'Complete targeting spec (replaces existing). Example: {"geo_locations":{"countries":["AU"]},"age_min":18}' },
        optimization_goal: { type: 'string' },
        promoted_object: { type: 'object', description: 'e.g. {"pixel_id":"123","custom_event_type":"PURCHASE"}' },
        is_dynamic_creative: { type: 'boolean' },
      },
      required: ['adset_id'],
    },
    zodSchema: z.object({
      adset_id: z.string().min(1), name: z.string().optional(),
      status: z.enum(statusEnum).optional(), daily_budget: z.string().optional(),
      lifetime_budget: z.string().optional(), bid_amount: z.number().optional(),
      bid_strategy: z.string().optional(), targeting: z.record(z.string(), z.unknown()).optional(),
      optimization_goal: z.string().optional(),
      promoted_object: z.record(z.string(), z.unknown()).optional(),
      is_dynamic_creative: z.boolean().optional(),
    }),
    async handler(args) {
      const { adset_id, ...updates } = this.zodSchema.parse(args);
      const body = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
      return success(await graphPost(`/${adset_id}`, body));
    },
  },
  {
    name: 'update_adset_daily_budget',
    description: 'Update the daily budget for an ad set. Budget in minor currency units (cents).',
    inputSchema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string' },
        daily_budget: { type: 'number', description: 'New daily budget in cents. Must be positive.' },
      },
      required: ['adset_id', 'daily_budget'],
    },
    zodSchema: z.object({ adset_id: z.string().min(1), daily_budget: z.number().int().positive() }),
    async handler(args) {
      const { adset_id, daily_budget } = this.zodSchema.parse(args);
      return success(await graphPost(`/${adset_id}`, { daily_budget }));
    },
  },

  // ═══════════════════════════ ADS ═══════════════════════════════════════
  {
    name: 'list_ads',
    description: 'List ads, optionally filtered by campaign or ad set.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' }, adset_id: { type: 'string' },
        limit: { type: 'number' }, status: { type: 'string', enum: [...statusEnum] },
      },
    },
    zodSchema: z.object({ campaign_id: z.string().optional(), adset_id: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), status: z.enum(statusEnum).optional() }),
    async handler(args) {
      const { campaign_id, adset_id, limit = 20, status } = this.zodSchema.parse(args);
      const parent = adset_id || campaign_id || await getAccountId();
      const params: Record<string, string> = { fields: AD_FIELDS, limit: String(limit) };
      if (status) params.filtering = JSON.stringify([{ field: 'effective_status', operator: 'IN', value: [status] }]);
      return success(await graphGet(`/${parent}/ads`, params));
    },
  },
  {
    name: 'get_ad_details',
    description: 'Get detailed ad info including creative details, preview links, and delivery status.',
    inputSchema: { type: 'object', properties: { ad_id: { type: 'string' } }, required: ['ad_id'] },
    zodSchema: z.object({ ad_id: z.string().min(1) }),
    async handler(args) {
      const { ad_id } = this.zodSchema.parse(args);
      return success(await graphGet(`/${ad_id}`, { fields: AD_FIELDS }));
    },
  },
  {
    name: 'create_ad',
    description: 'Create a new ad with an existing creative.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, adset_id: { type: 'string' }, creative_id: { type: 'string' },
        status: { type: 'string', enum: [...statusEnum] }, tracking_specs: { type: 'array' },
      },
      required: ['name', 'adset_id', 'creative_id'],
    },
    zodSchema: z.object({
      name: z.string().min(1), adset_id: z.string().min(1), creative_id: z.string().min(1),
      status: z.string().optional(), tracking_specs: z.array(z.record(z.string(), z.unknown())).optional(),
    }),
    async handler(args) {
      const parsed = this.zodSchema.parse(args);
      const id = await getAccountId();
      const body: Record<string, unknown> = {
        name: parsed.name, adset_id: parsed.adset_id,
        creative: { creative_id: parsed.creative_id },
        status: parsed.status || 'PAUSED',
      };
      if (parsed.tracking_specs) body.tracking_specs = parsed.tracking_specs;
      return success(await graphPost(`/${id}/ads`, body));
    },
  },
  {
    name: 'update_ad',
    description: 'Update an ad (status, creative, bid amount, tracking specs).',
    inputSchema: {
      type: 'object',
      properties: {
        ad_id: { type: 'string' }, status: { type: 'string', enum: [...statusEnum] },
        creative_id: { type: 'string' }, bid_amount: { type: 'number' }, tracking_specs: { type: 'array' },
      },
      required: ['ad_id'],
    },
    zodSchema: z.object({
      ad_id: z.string().min(1), status: z.enum(statusEnum).optional(),
      creative_id: z.string().optional(), bid_amount: z.number().optional(),
      tracking_specs: z.array(z.record(z.string(), z.unknown())).optional(),
    }),
    async handler(args) {
      const { ad_id, creative_id, ...rest } = this.zodSchema.parse(args);
      const body: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      if (creative_id) body.creative = { creative_id };
      return success(await graphPost(`/${ad_id}`, body));
    },
  },
  {
    name: 'get_ad_creatives',
    description: 'Get creative details for a specific ad (image, copy, headline, CTA, etc.).',
    inputSchema: { type: 'object', properties: { ad_id: { type: 'string' } }, required: ['ad_id'] },
    zodSchema: z.object({ ad_id: z.string().min(1) }),
    async handler(args) {
      const { ad_id } = this.zodSchema.parse(args);
      return success(await graphGet(`/${ad_id}/adcreatives`, {
        fields: 'id,name,title,body,image_url,image_hash,thumbnail_url,call_to_action_type,link_url,object_story_spec,asset_feed_spec',
      }));
    },
  },

  // ═══════════════════════════ CREATIVES ═════════════════════════════════
  {
    name: 'upload_ad_image',
    description: 'Upload an image for use in ad creatives. Provide image_url (URL to fetch).',
    inputSchema: {
      type: 'object',
      properties: {
        image_url: { type: 'string', description: 'URL of image to upload' },
        name: { type: 'string', description: 'Image name (optional)' },
      },
      required: ['image_url'],
    },
    zodSchema: z.object({ image_url: z.string().min(1), name: z.string().optional() }),
    async handler(args) {
      const { image_url, name } = this.zodSchema.parse(args);
      const id = await getAccountId();
      const imgRes = await fetch(image_url);
      if (!imgRes.ok) throw new ApiError(`Failed to download image: ${imgRes.statusText}`, 400);
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      const url = new URL(`${META_GRAPH_URL}/${id}/adimages`);
      url.searchParams.set('access_token', ACCESS_TOKEN!);
      const formData = new FormData();
      const blob = new Blob([buffer], { type: 'image/png' });
      formData.append('filename', blob, name || 'image.png');
      const res = await fetch(url.toString(), { method: 'POST', body: formData });
      const json = await res.json();
      if (!res.ok) throw new ApiError(JSON.stringify(json), res.status);
      return success(json);
    },
  },
  {
    name: 'create_ad_creative',
    description: 'Create a static image ad creative using an uploaded image hash. Requires page_id (use get_account_pages to find it). For catalog/DPA ads use create_dpa_creative instead.',
    inputSchema: {
      type: 'object',
      properties: {
        image_hash: { type: 'string' }, page_id: { type: 'string' },
        name: { type: 'string' }, link_url: { type: 'string' },
        message: { type: 'string' }, headline: { type: 'string' },
        description: { type: 'string' }, call_to_action_type: { type: 'string' },
        instagram_actor_id: { type: 'string', description: 'Optional Instagram account ID for Instagram placements' },
      },
      required: ['image_hash'],
    },
    zodSchema: z.object({
      image_hash: z.string().min(1), page_id: z.string().optional(),
      name: z.string().optional(), link_url: z.string().optional(),
      message: z.string().optional(), headline: z.string().optional(),
      description: z.string().optional(), call_to_action_type: z.string().optional(),
      instagram_actor_id: z.string().optional(),
    }),
    async handler(args) {
      const parsed = this.zodSchema.parse(args);
      const id = await getAccountId();
      const linkData: Record<string, unknown> = { image_hash: parsed.image_hash };
      if (parsed.link_url) linkData.link = parsed.link_url;
      if (parsed.message) linkData.message = parsed.message;
      if (parsed.headline) linkData.name = parsed.headline;
      if (parsed.description) linkData.description = parsed.description;
      if (parsed.call_to_action_type) linkData.call_to_action = { type: parsed.call_to_action_type };
      const storySpec: Record<string, unknown> = { link_data: linkData };
      if (parsed.page_id) storySpec.page_id = parsed.page_id;
      if (parsed.instagram_actor_id) storySpec.instagram_actor_id = parsed.instagram_actor_id;
      const body: Record<string, unknown> = { object_story_spec: storySpec };
      if (parsed.name) body.name = parsed.name;
      return success(await graphPost(`/${id}/adcreatives`, body));
    },
  },
  {
    name: 'create_dpa_creative',
    description: `Create a Dynamic Product Ad (DPA/catalog) creative using asset_feed_spec. This is the correct tool for catalog ads that show products dynamically from a Shopify/Meta catalog. Supports multiple body copy variations and headlines. Use get_product_catalogs and get_product_sets to find catalog_id and product_set_id first.`,
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Facebook Page ID (use get_account_pages)' },
        name: { type: 'string', description: 'Creative name' },
        product_catalog_id: { type: 'string', description: 'Catalog ID (use get_product_catalogs)' },
        product_set_id: { type: 'string', description: 'Product set ID within the catalog (use get_product_sets). Use an "in stock" filtered set.' },
        bodies: {
          type: 'array',
          items: { type: 'string' },
          description: 'Primary text variations (1–5). Supports {{product.name}}, {{product.price}}, {{product.brand}} tokens. Example: ["Handcrafted Indian jewellery ✨", "Loved by 10,000+ women across Australia"]',
        },
        headlines: {
          type: 'array',
          items: { type: 'string' },
          description: 'Headline variations (1–5). Supports product tokens. Example: ["{{product.name}}", "Shop Now"]',
        },
        descriptions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Description variations (optional). Example: ["Free shipping over $60"]',
        },
        link_url: { type: 'string', description: 'Default destination URL (fallback if no product URL)' },
        call_to_action_type: { type: 'string', description: 'CTA button. e.g. SHOP_NOW, LEARN_MORE, GET_OFFER' },
        image_hashes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional static image hashes to include alongside catalog images',
        },
        instagram_actor_id: { type: 'string', description: 'Optional Instagram account ID' },
      },
      required: ['page_id', 'product_catalog_id', 'bodies', 'headlines'],
    },
    zodSchema: z.object({
      page_id: z.string().min(1),
      name: z.string().optional(),
      product_catalog_id: z.string().min(1),
      product_set_id: z.string().optional(),
      bodies: z.array(z.string()).min(1).max(5),
      headlines: z.array(z.string()).min(1).max(5),
      descriptions: z.array(z.string()).max(5).optional(),
      link_url: z.string().optional(),
      call_to_action_type: z.string().optional(),
      image_hashes: z.array(z.string()).optional(),
      instagram_actor_id: z.string().optional(),
    }),
    async handler(args) {
      const parsed = this.zodSchema.parse(args);
      const id = await getAccountId();

      const assetFeedSpec: Record<string, unknown> = {
        bodies: parsed.bodies.map((text: string) => ({ text })),
        titles: parsed.headlines.map((text: string) => ({ text })),
        call_to_action_types: [parsed.call_to_action_type || 'SHOP_NOW'],
      };

      if (parsed.descriptions?.length) {
        assetFeedSpec.descriptions = parsed.descriptions.map((text: string) => ({ text }));
      }
      if (parsed.link_url) {
        assetFeedSpec.link_urls = [{ website_url: parsed.link_url }];
      }
      if (parsed.image_hashes?.length) {
        assetFeedSpec.images = parsed.image_hashes.map((hash: string) => ({ hash }));
      }

      // For DPA/catalog ads: the product_catalog_id and product_set_id are linked
      // at the AD SET level via promoted_object — not inside the creative.
      // The creative just needs asset_feed_spec with copy + images.
      // We store product_set_id as top-level on creative for reference (Meta ignores extra fields).

      // Use AUTOMATIC_FORMAT to match Ads Manager's default DPA format
      assetFeedSpec.ad_formats = ['AUTOMATIC_FORMAT'];

      const body: Record<string, unknown> = {
        name: parsed.name || `DPA Creative - ${new Date().toISOString().slice(0, 10)}`,
        asset_feed_spec: assetFeedSpec,
        object_type: 'SHARE',
      };
      if (parsed.product_set_id) body.product_set_id = parsed.product_set_id;
      if (parsed.instagram_actor_id) body.instagram_actor_id = parsed.instagram_actor_id;

      try {
        return success(await graphPost(`/${id}/adcreatives`, body));
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 400) {
          throw new ApiError(
            `${err.message} | NOTE: Creating DPA/catalog creatives from scratch requires the catalog_management permission on your Meta app. ` +
            `Workaround: Use duplicate_creative to copy an existing working DPA creative (e.g. creative ID 2271602833243457) ` +
            `and then attach it to new ad sets. The copy will use the same product catalog automatically.`,
            400
          );
        }
        throw err;
      }
    },
  },
  {
    name: 'create_carousel_ad_creative',
    description: 'Create a carousel ad creative with 2–10 cards (images/videos). Each card has its own image, headline, description, and link. Great for showcasing multiple products or telling a story.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Facebook Page ID (use get_account_pages)' },
        name: { type: 'string', description: 'Creative name' },
        message: { type: 'string', description: 'Primary text shown above the carousel' },
        link: { type: 'string', description: 'Default destination URL' },
        call_to_action_type: { type: 'string', description: 'Global CTA. e.g. SHOP_NOW, LEARN_MORE' },
        child_attachments: {
          type: 'array',
          description: '2–10 carousel cards. Each: {image_hash, link, name (headline), description, call_to_action}',
          items: {
            type: 'object',
            properties: {
              image_hash: { type: 'string' },
              link: { type: 'string' },
              name: { type: 'string', description: 'Card headline (max 40 chars)' },
              description: { type: 'string', description: 'Card description (max 20 chars)' },
            },
            required: ['image_hash', 'link'],
          },
        },
        multi_share_optimized: { type: 'boolean', description: 'Let Meta optimise card order (default: true)' },
        instagram_actor_id: { type: 'string', description: 'Optional Instagram account ID' },
      },
      required: ['page_id', 'child_attachments'],
    },
    zodSchema: z.object({
      page_id: z.string().min(1),
      name: z.string().optional(),
      message: z.string().optional(),
      link: z.string().optional(),
      call_to_action_type: z.string().optional(),
      child_attachments: z.array(z.object({
        image_hash: z.string().min(1),
        link: z.string().min(1),
        name: z.string().optional(),
        description: z.string().optional(),
      })).min(2).max(10),
      multi_share_optimized: z.boolean().optional(),
      instagram_actor_id: z.string().optional(),
    }),
    async handler(args) {
      const parsed = this.zodSchema.parse(args);
      const id = await getAccountId();

      const cards = parsed.child_attachments.map((c: { image_hash: string; link: string; name?: string; description?: string }) => ({
        image_hash: c.image_hash,
        link: c.link,
        ...(c.name ? { name: c.name } : {}),
        ...(c.description ? { description: c.description } : {}),
        ...(parsed.call_to_action_type ? { call_to_action: { type: parsed.call_to_action_type, value: { link: c.link } } } : {}),
      }));

      const linkData: Record<string, unknown> = {
        link: parsed.link || parsed.child_attachments[0].link,
        child_attachments: cards,
        multi_share_optimized: parsed.multi_share_optimized !== false,
      };
      if (parsed.message) linkData.message = parsed.message;
      if (parsed.call_to_action_type) linkData.call_to_action = { type: parsed.call_to_action_type };

      const storySpec: Record<string, unknown> = {
        page_id: parsed.page_id,
        link_data: linkData,
      };
      if (parsed.instagram_actor_id) storySpec.instagram_actor_id = parsed.instagram_actor_id;

      const body: Record<string, unknown> = {
        name: parsed.name || `Carousel Creative - ${new Date().toISOString().slice(0, 10)}`,
        object_story_spec: storySpec,
      };
      return success(await graphPost(`/${id}/adcreatives`, body));
    },
  },
  {
    name: 'update_ad_creative',
    description: 'Update an existing ad creative name, copy, headline, or description. Note: asset_feed_spec (DPA copy variations) cannot be updated on published creatives — duplicate the creative instead.',
    inputSchema: {
      type: 'object',
      properties: {
        creative_id: { type: 'string' }, name: { type: 'string' },
        message: { type: 'string' }, headline: { type: 'string' },
        description: { type: 'string' }, call_to_action_type: { type: 'string' },
      },
      required: ['creative_id'],
    },
    zodSchema: z.object({
      creative_id: z.string().min(1), name: z.string().optional(),
      message: z.string().optional(), headline: z.string().optional(),
      description: z.string().optional(), call_to_action_type: z.string().optional(),
    }),
    async handler(args) {
      const { creative_id, ...updates } = this.zodSchema.parse(args);
      const body = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
      return success(await graphPost(`/${creative_id}`, body));
    },
  },

  // ═══════════════════════════ CATALOG / PRODUCT SETS ════════════════════
  {
    name: 'get_product_catalogs',
    description: 'Get product catalogs linked to the ad account. Returns catalog IDs and names. Use catalog_id with create_dpa_creative and create_adset promoted_object.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    zodSchema: z.object({ limit: z.number().optional() }),
    async handler(args) {
      const { limit = 20 } = this.zodSchema.parse(args);
      const id = await getAccountId();
      const errors: string[] = [];

      // Approach 1: direct account-level endpoint
      try {
        return success(await graphGet(`/${id}/product_catalogs`, {
          fields: 'id,name,product_count,vertical',
          limit: String(limit),
        }));
      } catch (e) { errors.push(`account endpoint: ${e instanceof Error ? e.message : e}`); }

      // Approach 2: via user's businesses list
      try {
        const businesses = (await graphGet('/me/businesses', {
          fields: 'id,name',
          limit: '10',
        })) as { data: Array<{ id: string; name: string }> };
        const allCatalogs: unknown[] = [];
        for (const biz of (businesses.data || [])) {
          try {
            const cats = (await graphGet(`/${biz.id}/owned_product_catalogs`, {
              fields: 'id,name,product_count,vertical',
              limit: String(limit),
            })) as { data: unknown[] };
            allCatalogs.push(...(cats.data || []));
          } catch {}
        }
        if (allCatalogs.length > 0) return success({ data: allCatalogs });
      } catch (e) { errors.push(`businesses endpoint: ${e instanceof Error ? e.message : e}`); }

      // Approach 3: try /me/product_catalogs
      try {
        return success(await graphGet('/me/product_catalogs', {
          fields: 'id,name,product_count,vertical',
          limit: String(limit),
        }));
      } catch (e) { errors.push(`/me endpoint: ${e instanceof Error ? e.message : e}`); }

      // Meta's catalog API requires Commerce Manager-level OAuth scopes
      // which are separate from the standard Ads API token.
      // Return a helpful message rather than throwing.
      return success({
        data: [],
        _note: 'Could not fetch catalogs automatically — this requires Commerce Manager permissions. ' +
          'If you know your Catalog ID (find it at business.facebook.com/commerce → your catalog → Settings), ' +
          'pass it directly to get_product_sets to list your product sets. ' +
          `Attempted endpoints: ${errors.join(' | ')}`,
      });
    },
  },
  {
    name: 'get_product_sets',
    description: 'Get product sets within a catalog. Product sets are filtered subsets of a catalog (e.g. "In Stock Only"). Use product_set_id with create_dpa_creative and in ad set promoted_object.',
    inputSchema: {
      type: 'object',
      properties: {
        catalog_id: { type: 'string', description: 'Catalog ID from get_product_catalogs' },
        limit: { type: 'number' },
      },
      required: ['catalog_id'],
    },
    zodSchema: z.object({ catalog_id: z.string().min(1), limit: z.number().optional() }),
    async handler(args) {
      const { catalog_id, limit = 50 } = this.zodSchema.parse(args);
      return success(await graphGet(`/${catalog_id}/product_sets`, {
        fields: 'id,name,product_count,filter',
        limit: String(limit),
      }));
    },
  },
  {
    name: 'create_product_set',
    description: 'Create a filtered product set within a catalog. Most commonly used to create an "In Stock Only" set to exclude sold-out products from DPA ads.',
    inputSchema: {
      type: 'object',
      properties: {
        catalog_id: { type: 'string', description: 'Catalog ID from get_product_catalogs' },
        name: { type: 'string', description: 'Product set name, e.g. "In Stock Only"' },
        filter: {
          type: 'object',
          description: 'Filter spec. For in-stock only: {"availability":{"i_contains":"in stock"}}. For a collection: {"product_type":{"i_contains":"necklace"}}',
        },
      },
      required: ['catalog_id', 'name', 'filter'],
    },
    zodSchema: z.object({
      catalog_id: z.string().min(1),
      name: z.string().min(1),
      filter: z.record(z.string(), z.unknown()),
    }),
    async handler(args) {
      const { catalog_id, name, filter } = this.zodSchema.parse(args);
      return success(await graphPost(`/${catalog_id}/product_sets`, { name, filter }));
    },
  },

  // ═══════════════════════════ INSIGHTS ══════════════════════════════════
  {
    name: 'get_insights',
    description: 'Get performance insights (spend, impressions, clicks, conversions, etc.). Supports custom date ranges, time breakdowns (day/week/month), breakdowns by device/age/gender/country, compact mode to strip redundant action types, and attribution windows.',
    inputSchema: {
      type: 'object',
      properties: {
        object_id: { type: 'string', description: 'Campaign/adset/ad ID. Omit for account-level.' },
        time_range: { description: 'Preset string (last_7d, last_14d, last_30d, this_month, last_month, today, yesterday, this_week, last_week) OR {since, until} object with YYYY-MM-DD dates. Default: last_7d' },
        date_preset: { type: 'string', enum: [...datePresetEnum], description: 'DEPRECATED: use time_range instead. Kept for backwards compatibility.' },
        time_breakdown: { type: 'string', enum: ['day', 'week', 'month'], description: 'Segment metrics by day, week, or month. Returns segmented_metrics array.' },
        time_increment: { type: 'number', description: 'Legacy: 1 = daily, 7 = weekly. Prefer time_breakdown instead.' },
        breakdowns: { type: 'string', enum: [...breakdownEnum] },
        level: { type: 'string', enum: ['account', 'campaign', 'adset', 'ad'] },
        limit: { type: 'number' }, after: { type: 'string' },
        action_attribution_windows: { type: 'string', description: 'e.g. "7d_click,1d_view"' },
        compact: { type: 'boolean', description: 'Strip redundant action types (omni_*, offsite_conversion.fb_pixel_*, etc.) to reduce response size by ~60%. Default: false' },
      },
    },
    zodSchema: z.object({
      object_id: z.string().optional(),
      time_range: z.union([z.string(), z.object({ since: z.string(), until: z.string() })]).optional(),
      date_preset: z.string().optional(),
      time_breakdown: z.enum(['day', 'week', 'month']).optional(),
      time_increment: z.number().int().min(1).max(90).optional(),
      breakdowns: z.string().optional(),
      level: z.enum(['account', 'campaign', 'adset', 'ad']).optional(),
      limit: z.number().optional(), after: z.string().optional(),
      action_attribution_windows: z.string().optional(),
      compact: z.boolean().optional(),
    }),
    async handler(args) {
      const { object_id, time_range, date_preset, time_breakdown, compact, ...rest } = this.zodSchema.parse(args);
      const target = object_id || await getAccountId();
      const params: Record<string, string> = { fields: INSIGHT_FIELDS };

      // Handle time range: prefer time_range over date_preset
      if (time_range) {
        if (typeof time_range === 'object') {
          params.time_range = JSON.stringify(time_range);
        } else {
          // Check if it's a preset that can use date_preset directly
          const presets = new Set(datePresetEnum);
          if (presets.has(time_range as typeof datePresetEnum[number])) {
            params.date_preset = time_range;
          } else {
            // Resolve to {since, until}
            params.time_range = JSON.stringify(resolveDateRange(time_range));
          }
        }
      } else if (date_preset) {
        params.date_preset = date_preset;
      } else {
        params.date_preset = 'last_7d';
      }

      // Handle time_breakdown → time_increment mapping
      if (time_breakdown) {
        switch (time_breakdown) {
          case 'day': params.time_increment = '1'; break;
          case 'week': params.time_increment = '7'; break;
          case 'month': params.time_increment = 'monthly'; break;
        }
      } else if (rest.time_increment) {
        params.time_increment = String(rest.time_increment);
      }

      if (rest.breakdowns) params.breakdowns = rest.breakdowns;
      if (rest.level) params.level = rest.level;
      if (rest.limit) params.limit = String(rest.limit);
      if (rest.after) params.after = rest.after;
      if (rest.action_attribution_windows) params.action_attribution_windows = rest.action_attribution_windows;

      let result = await graphGet(`/${target}/insights`, params);

      if (compact) result = stripRedundantActions(result);

      return success(result);
    },
  },
  {
    name: 'insights_daily_by_device',
    description: 'Shortcut: daily performance broken down by device platform (mobile, desktop, tablet).',
    inputSchema: { type: 'object', properties: {
      date_preset: { type: 'string', enum: [...datePresetEnum] },
      compact: { type: 'boolean', description: 'Strip redundant action types. Default: false' },
    } },
    zodSchema: z.object({ date_preset: z.string().optional(), compact: z.boolean().optional() }),
    async handler(args) {
      const { date_preset = 'last_7d', compact } = this.zodSchema.parse(args);
      const id = await getAccountId();
      let result = await graphGet(`/${id}/insights`, {
        fields: INSIGHT_FIELDS, date_preset, time_increment: '1', breakdowns: 'device_platform',
      });
      if (compact) result = stripRedundantActions(result);
      return success(result);
    },
  },

  {
    name: 'bulk_get_insights',
    description: 'Get performance insights for multiple campaigns, ad sets, or ads in parallel. Supports custom date ranges, time breakdowns, campaign name filtering, and compact mode with selectable fields.',
    inputSchema: {
      type: 'object',
      properties: {
        object_ids: {
          type: 'array', items: { type: 'string' },
          description: 'Array of campaign/adset/ad IDs to fetch insights for. Max 50. Omit to auto-fetch all campaigns.',
        },
        time_range: { description: 'Preset string or {since, until} object. Default: last_7d' },
        date_preset: { type: 'string', enum: [...datePresetEnum], description: 'Default: last_7d' },
        level: { type: 'string', enum: ['campaign', 'adset', 'ad'], description: 'Level of the IDs provided' },
        time_breakdown: { type: 'string', enum: ['day', 'week', 'month'], description: 'Segment metrics by time period' },
        time_increment: { type: 'number', description: '1 = daily breakdown' },
        campaign_name_contains: {
          type: 'array', items: { type: 'string' },
          description: 'Filter results to only campaigns whose name contains any of these strings (case-insensitive). E.g. ["TOF", "BOF"]',
        },
        compact: { type: 'boolean', description: 'Strip redundant action types for smaller response. Default: false' },
        action_attribution_windows: { type: 'string', description: 'e.g. "7d_click,1d_view"' },
      },
    },
    zodSchema: z.object({
      object_ids: z.array(z.string().min(1)).min(1).max(50).optional(),
      time_range: z.union([z.string(), z.object({ since: z.string(), until: z.string() })]).optional(),
      date_preset: z.string().optional(),
      level: z.enum(['campaign', 'adset', 'ad']).optional(),
      time_breakdown: z.enum(['day', 'week', 'month']).optional(),
      time_increment: z.number().int().min(1).max(90).optional(),
      campaign_name_contains: z.array(z.string()).optional(),
      compact: z.boolean().optional(),
      action_attribution_windows: z.string().optional(),
    }),
    async handler(args) {
      const { object_ids: providedIds, time_range, date_preset, level, time_breakdown, time_increment, campaign_name_contains, compact, action_attribution_windows } = this.zodSchema.parse(args);

      // If no IDs provided, auto-fetch all campaigns
      let objectIds = providedIds;
      if (!objectIds) {
        const accountId = await getAccountId();
        const campaigns = (await graphGet(`/${accountId}/campaigns`, {
          fields: 'id,name', limit: '50',
          filtering: JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] }]),
        })) as { data: Array<{ id: string; name: string }> };
        let filtered = campaigns.data || [];
        if (campaign_name_contains?.length) {
          const filters = campaign_name_contains.map((f: string) => f.toLowerCase());
          filtered = filtered.filter((c) => filters.some((f: string) => c.name.toLowerCase().includes(f)));
        }
        objectIds = filtered.map((c) => c.id);
      }

      const params: Record<string, string> = { fields: INSIGHT_FIELDS };
      // Handle time range
      if (time_range) {
        if (typeof time_range === 'object') {
          params.time_range = JSON.stringify(time_range);
        } else {
          const presets = new Set(datePresetEnum);
          if (presets.has(time_range as typeof datePresetEnum[number])) {
            params.date_preset = time_range;
          } else {
            params.time_range = JSON.stringify(resolveDateRange(time_range));
          }
        }
      } else if (date_preset) {
        params.date_preset = date_preset;
      } else {
        params.date_preset = 'last_7d';
      }

      if (time_breakdown) {
        switch (time_breakdown) {
          case 'day': params.time_increment = '1'; break;
          case 'week': params.time_increment = '7'; break;
          case 'month': params.time_increment = 'monthly'; break;
        }
      } else if (time_increment) {
        params.time_increment = String(time_increment);
      }
      if (level) params.level = level;
      if (action_attribution_windows) params.action_attribution_windows = action_attribution_windows;

      const results = await Promise.allSettled(
        objectIds.map((id: string) => graphGet(`/${id}/insights`, params))
      );

      let output: Array<Record<string, unknown>> = objectIds.map((id: string, i: number) => {
        const r = results[i];
        if (r.status === 'fulfilled') {
          let data = r.value;
          if (compact) data = stripRedundantActions(data);
          return { id, data };
        }
        return { id, error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
      });

      // Post-filter by campaign name if IDs were provided explicitly
      if (campaign_name_contains?.length && providedIds) {
        const filters = campaign_name_contains.map((f: string) => f.toLowerCase());
        output = output.filter((item: Record<string, unknown>) => {
          const data = item.data as { data?: Array<Record<string, unknown>> } | undefined;
          if (!data?.data?.length) return true; // keep errors/empty for visibility
          return data.data.some((row) => {
            const name = String(row.campaign_name || '').toLowerCase();
            return filters.some((f: string) => name.includes(f));
          });
        });
      }

      return success({ results: output, total: output.length });
    },
  },

  // ═══════════════════════════ GENERATE REPORT ═══════════════════════════
  {
    name: 'generate_report',
    description: `Generate a comprehensive performance report for Meta Ads in a single call. Returns: account summary with derived metrics (ROAS, CPA, cost per ATC), daily breakdown, period-over-period comparison (WoW/MoM), and per-campaign metrics with individual comparisons. Use this when asked to "report on Meta Ads", "how are campaigns doing", or "weekly report". The LLM MUST then write commentary covering: (1) How is it going — reference specific metrics, (2) Do we need to change anything — flag campaigns outside targets, (3) Should we conclude and run new ads — check learning phase (50 conversions threshold), (4) Specific recommendations with campaign names and actionable changes.`,
    inputSchema: {
      type: 'object',
      properties: {
        time_range: {
          description: 'Preset (last_7d, last_14d, last_30d, this_week, last_week, this_month, last_month) or {since, until} with YYYY-MM-DD dates. Default: last_7d',
        },
        compare_previous: { type: 'boolean', description: 'Include previous period comparison for WoW/MoM analysis (default: true)' },
        campaign_name_contains: {
          type: 'array', items: { type: 'string' },
          description: 'Filter to specific campaigns by name (case-insensitive). E.g. ["TOF", "MOF", "BOF"]',
        },
      },
    },
    zodSchema: z.object({
      time_range: z.union([z.string(), z.object({ since: z.string(), until: z.string() })]).optional(),
      compare_previous: z.boolean().optional(),
      campaign_name_contains: z.array(z.string()).optional(),
    }),
    async handler(args) {
      const { time_range = 'last_7d', compare_previous = true, campaign_name_contains } = this.zodSchema.parse(args);
      const accountId = await getAccountId();

      // Resolve date range
      const currentRange = resolveDateRange(time_range);
      const timeRangeParam = JSON.stringify(currentRange);

      // Build parallel API calls
      const calls: Array<Promise<unknown>> = [];

      // 0: Account-level summary for current period
      calls.push(graphGet(`/${accountId}/insights`, {
        fields: INSIGHT_FIELDS, time_range: timeRangeParam, level: 'account',
      }));

      // 1: Campaign-level breakdown for current period
      calls.push(graphGet(`/${accountId}/insights`, {
        fields: INSIGHT_FIELDS, time_range: timeRangeParam, level: 'campaign', limit: '50',
      }));

      // 2: Daily breakdown for current period
      calls.push(graphGet(`/${accountId}/insights`, {
        fields: INSIGHT_FIELDS, time_range: timeRangeParam, time_increment: '1', level: 'account',
      }));

      // 3+4: Previous period for comparison
      if (compare_previous) {
        const prevRange = getPreviousPeriod(currentRange.since, currentRange.until);
        const prevRangeParam = JSON.stringify(prevRange);
        calls.push(graphGet(`/${accountId}/insights`, {
          fields: INSIGHT_FIELDS, time_range: prevRangeParam, level: 'account',
        }));
        calls.push(graphGet(`/${accountId}/insights`, {
          fields: INSIGHT_FIELDS, time_range: prevRangeParam, level: 'campaign', limit: '50',
        }));
      }

      const results = await Promise.allSettled(calls);
      const extract = (r: PromiseSettledResult<unknown>) => {
        if (r.status === 'fulfilled') return ((r.value as Record<string, unknown>)?.data as unknown[]) || [];
        return [];
      };

      const accountData = extract(results[0]);
      const campaignData = extract(results[1]);
      const dailyData = extract(results[2]);
      const prevAccountData = compare_previous ? extract(results[3]) : [];
      const prevCampaignData = compare_previous ? extract(results[4]) : [];

      // Account summary with derived metrics
      const accountSummary = accountData.length > 0 ? calcDerivedMetrics(accountData[0] as Record<string, unknown>) : null;

      // Daily breakdown
      const daily = dailyData.map((row: unknown) => ({
        date: (row as Record<string, unknown>).date_start,
        ...calcDerivedMetrics(row as Record<string, unknown>),
      }));

      // Campaign breakdown
      let campaigns = campaignData.map((row: unknown) => {
        const r = row as Record<string, unknown>;
        return {
          campaign_id: r.campaign_id, campaign_name: r.campaign_name,
          ...calcDerivedMetrics(r),
        };
      });

      // Filter by campaign name
      if (campaign_name_contains?.length) {
        const filters = campaign_name_contains.map((f: string) => f.toLowerCase());
        campaigns = campaigns.filter((c: Record<string, unknown>) =>
          filters.some((f: string) => String(c.campaign_name || '').toLowerCase().includes(f))
        );
      }

      // Filter zero-spend and sort by spend desc
      campaigns = campaigns.filter((c: Record<string, unknown>) => (c.spend as number) > 0);
      campaigns.sort((a: Record<string, unknown>, b: Record<string, unknown>) => (b.spend as number) - (a.spend as number));

      // Period comparison
      let periodComparison: Record<string, unknown> | null = null;
      if (compare_previous && prevAccountData.length > 0 && accountSummary) {
        const prevSummary = calcDerivedMetrics(prevAccountData[0] as Record<string, unknown>);
        const comparisonMetrics = ['spend', 'roas', 'cpa', 'impressions', 'clicks', 'purchases', 'revenue', 'ctr', 'cpm', 'reach', 'frequency', 'add_to_carts', 'initiate_checkouts', 'view_contents'];
        const changes: Record<string, unknown> = {};
        for (const m of comparisonMetrics) {
          changes[m] = pctChange(
            (accountSummary as Record<string, unknown>)[m] as number || 0,
            (prevSummary as Record<string, unknown>)[m] as number || 0
          );
        }
        const prevRange = getPreviousPeriod(currentRange.since, currentRange.until);
        periodComparison = {
          this_period: { range: `${currentRange.since} → ${currentRange.until}`, ...accountSummary },
          previous_period: { range: `${prevRange.since} → ${prevRange.until}`, ...prevSummary },
          changes,
        };
      }

      // Per-campaign comparison
      let campaignWithComparison: Array<Record<string, unknown>> = campaigns;
      if (compare_previous && prevCampaignData.length > 0) {
        const prevMap = new Map<string, Record<string, unknown>>();
        for (const row of prevCampaignData) {
          const r = row as Record<string, unknown>;
          prevMap.set(String(r.campaign_id), calcDerivedMetrics(r));
        }
        campaignWithComparison = campaigns.map((c: Record<string, unknown>): Record<string, unknown> => {
          const prev = prevMap.get(String(c.campaign_id));
          if (!prev) return { ...c, vs_previous: null };
          const changes: Record<string, unknown> = {};
          for (const m of ['spend', 'roas', 'cpa', 'purchases', 'revenue', 'ctr', 'impressions']) {
            changes[m] = pctChange((c[m] as number) || 0, (prev[m] as number) || 0);
          }
          return { ...c, vs_previous: changes };
        });
      }

      const report = {
        period: `${currentRange.since} → ${currentRange.until}`,
        generated_at: new Date().toISOString(),
        account_summary: accountSummary,
        daily_breakdown: daily,
        period_comparison: periodComparison,
        by_campaign: campaignWithComparison,
        _commentary_guidance: 'IMPORTANT: After presenting the data, write commentary covering these 4 sections: ' +
          '(1) HOW IS IT GOING — reference specific ROAS, CPA, frequency numbers. Is frequency < 2? Is ROAS > 2x? ' +
          '(2) DO WE NEED TO CHANGE ANYTHING — flag any campaign with CPA > $20 or ROAS < 2x or frequency > 3. ' +
          '(3) SHOULD WE CONCLUDE AND RUN NEW ADS — check if total purchases < 50 (still in learning phase). ' +
          '(4) RECOMMENDATIONS — 2-3 specific actions with campaign names, e.g. "Increase BOF budget by 20%" or "Refresh TOF creative".',
      };

      return success(report);
    },
  },

  // ═══════════════════════════ TARGETING ═════════════════════════════════
  {
    name: 'search_interests',
    description: 'Search for interest targeting options by keyword.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
    zodSchema: z.object({ query: z.string().min(1), limit: z.number().optional() }),
    async handler(args) {
      const { query, limit = 25 } = this.zodSchema.parse(args);
      return success(await graphGet('/search', { type: 'adinterest', q: query, limit: String(limit) }));
    },
  },
  {
    name: 'get_interest_suggestions',
    description: 'Get related interest suggestions based on existing interests.',
    inputSchema: { type: 'object', properties: { interest_list: { type: 'string' }, limit: { type: 'number' } }, required: ['interest_list'] },
    zodSchema: z.object({ interest_list: z.string().min(1), limit: z.number().optional() }),
    async handler(args) {
      const { interest_list, limit = 25 } = this.zodSchema.parse(args);
      return success(await graphGet('/search', { type: 'adinterestsuggestion', interest_list, limit: String(limit) }));
    },
  },
  {
    name: 'search_behaviors',
    description: 'Get available behavior targeting options.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    zodSchema: z.object({ limit: z.number().optional() }),
    async handler(args) {
      const { limit = 50 } = this.zodSchema.parse(args);
      return success(await graphGet('/search', { type: 'adTargetingCategory', class: 'behaviors', limit: String(limit) }));
    },
  },
  {
    name: 'search_demographics',
    description: 'Get demographic targeting options. Classes: demographics, life_events, industries, income, family_statuses, user_device, user_os.',
    inputSchema: { type: 'object', properties: { demographic_class: { type: 'string' }, limit: { type: 'number' } } },
    zodSchema: z.object({ demographic_class: z.string().optional(), limit: z.number().optional() }),
    async handler(args) {
      const { demographic_class = 'demographics', limit = 50 } = this.zodSchema.parse(args);
      return success(await graphGet('/search', { type: 'adTargetingCategory', class: demographic_class, limit: String(limit) }));
    },
  },
  {
    name: 'search_geo_locations',
    description: 'Search for geographic targeting locations (countries, regions, cities, zip codes).',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, location_types: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
    zodSchema: z.object({ query: z.string().min(1), location_types: z.string().optional(), limit: z.number().optional() }),
    async handler(args) {
      const { query, location_types, limit = 25 } = this.zodSchema.parse(args);
      const params: Record<string, string> = { type: 'adgeolocation', q: query, limit: String(limit) };
      if (location_types) params.location_types = location_types;
      return success(await graphGet('/search', params));
    },
  },
  {
    name: 'estimate_audience_size',
    description: 'Estimate audience size for targeting specifications.',
    inputSchema: {
      type: 'object',
      properties: {
        targeting: { type: 'object', description: 'Targeting spec (geo_locations, age_min, age_max, flexible_spec, etc.)' },
        optimization_goal: { type: 'string', description: 'Default: REACH' },
      },
    },
    zodSchema: z.object({ targeting: z.record(z.string(), z.unknown()).optional(), optimization_goal: z.string().optional() }),
    async handler(args) {
      const { targeting, optimization_goal = 'REACH' } = this.zodSchema.parse(args);
      const id = await getAccountId();
      const params: Record<string, string> = { optimization_goal };
      if (targeting) params.targeting_spec = JSON.stringify(targeting);
      try {
        return success(await graphGet(`/${id}/reachestimate`, params));
      } catch {
        return success(await graphGet(`/${id}/delivery_estimate`, params));
      }
    },
  },

  // ═══════════════════════════ DUPLICATION ═══════════════════════════════
  {
    name: 'duplicate_campaign',
    description: 'Duplicate a campaign with all its ad sets and ads. Great for A/B testing.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' }, name_suffix: { type: 'string' },
        new_daily_budget: { type: 'string' }, new_status: { type: 'string', enum: [...statusEnum] },
      },
      required: ['campaign_id'],
    },
    zodSchema: z.object({ campaign_id: z.string().min(1), name_suffix: z.string().optional(), new_daily_budget: z.string().optional(), new_status: z.string().optional() }),
    async handler(args) {
      const { campaign_id, name_suffix, new_daily_budget, new_status } = this.zodSchema.parse(args);
      const body: Record<string, unknown> = { status_option: new_status || 'PAUSED' };
      if (name_suffix) body.rename_options = { rename_suffix: name_suffix };
      if (new_daily_budget) body.daily_budget = new_daily_budget;
      return success(await graphPost(`/${campaign_id}/copies`, body));
    },
  },
  {
    name: 'duplicate_adset',
    description: 'Duplicate an ad set with its ads. Can move to a different campaign.',
    inputSchema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string' }, target_campaign_id: { type: 'string' },
        name_suffix: { type: 'string' }, new_daily_budget: { type: 'string' },
        new_status: { type: 'string', enum: [...statusEnum] },
      },
      required: ['adset_id'],
    },
    zodSchema: z.object({ adset_id: z.string().min(1), target_campaign_id: z.string().optional(), name_suffix: z.string().optional(), new_daily_budget: z.string().optional(), new_status: z.string().optional() }),
    async handler(args) {
      const { adset_id, target_campaign_id, name_suffix, new_daily_budget, new_status } = this.zodSchema.parse(args);
      const body: Record<string, unknown> = { status_option: new_status || 'PAUSED' };
      if (name_suffix) body.rename_options = { rename_suffix: name_suffix };
      if (target_campaign_id) body.campaign_id = target_campaign_id;
      if (new_daily_budget) body.daily_budget = new_daily_budget;
      return success(await graphPost(`/${adset_id}/copies`, body));
    },
  },
  {
    name: 'duplicate_ad',
    description: 'Duplicate an ad. Can move to a different ad set.',
    inputSchema: {
      type: 'object',
      properties: {
        ad_id: { type: 'string' }, target_adset_id: { type: 'string' },
        name_suffix: { type: 'string' }, new_status: { type: 'string', enum: [...statusEnum] },
      },
      required: ['ad_id'],
    },
    zodSchema: z.object({ ad_id: z.string().min(1), target_adset_id: z.string().optional(), name_suffix: z.string().optional(), new_status: z.string().optional() }),
    async handler(args) {
      const { ad_id, target_adset_id, name_suffix, new_status } = this.zodSchema.parse(args);
      const body: Record<string, unknown> = { status_option: new_status || 'PAUSED' };
      if (name_suffix) body.rename_options = { rename_suffix: name_suffix };
      if (target_adset_id) body.adset_id = target_adset_id;
      return success(await graphPost(`/${ad_id}/copies`, body));
    },
  },

  {
    name: 'duplicate_creative',
    description: `Duplicate an existing ad creative by fetching its full spec and re-posting it as a new creative. Works for static image creatives (object_story_spec). DPA/catalog creatives (asset_feed_spec) can be duplicated without overrides; text overrides on DPA creatives are not supported due to Meta's placement-based validation. Supports optional overrides for name, primary text, headline, description, CTA type, and destination URL. TIP: Instead of duplicating, you can attach the same creative_id to multiple ads/ad sets directly using create_ad — no copy needed.`,
    inputSchema: {
      type: 'object',
      properties: {
        creative_id: { type: 'string', description: 'Creative ID to duplicate' },
        name_suffix: { type: 'string', description: 'Suffix to append to the copied creative name (e.g. " - TOF V2")' },
        new_name: { type: 'string', description: 'Override full name for the new creative (overrides name_suffix)' },
        new_primary_text: { type: 'string', description: 'Override primary text / body copy' },
        new_headline: { type: 'string', description: 'Override headline' },
        new_description: { type: 'string', description: 'Override description' },
        new_cta_type: { type: 'string', description: 'Override CTA type (e.g. SHOP_NOW, LEARN_MORE, BUY_NOW)' },
        new_destination_url: { type: 'string', description: 'Override destination / landing page URL' },
      },
      required: ['creative_id'],
    },
    zodSchema: z.object({
      creative_id: z.string().min(1),
      name_suffix: z.string().optional(),
      new_name: z.string().optional(),
      new_primary_text: z.string().optional(),
      new_headline: z.string().optional(),
      new_description: z.string().optional(),
      new_cta_type: z.string().optional(),
      new_destination_url: z.string().optional(),
    }),
    async handler(args) {
      const {
        creative_id, name_suffix, new_name,
        new_primary_text, new_headline, new_description, new_cta_type, new_destination_url,
      } = this.zodSchema.parse(args);

      // Fetch the original creative's full spec
      const original = (await graphGet(`/${creative_id}`, {
        fields: 'id,name,object_story_spec,asset_feed_spec,instagram_actor_id,object_type',
      })) as Record<string, unknown>;

      const copiedName = new_name || `${(original.name as string) || creative_id}${name_suffix || ' - Copy'}`;
      const accountId = await getAccountId();
      const body: Record<string, unknown> = { name: copiedName };

      // Copy object_story_spec (standard static image / video / link ads)
      if (original.object_story_spec) {
        const spec = JSON.parse(JSON.stringify(original.object_story_spec)) as Record<string, unknown>;
        // Apply link_data overrides
        if (new_primary_text || new_headline || new_description || new_destination_url || new_cta_type) {
          const linkData = ((spec.link_data as Record<string, unknown>) || {});
          if (new_primary_text) linkData.message = new_primary_text;
          if (new_headline) linkData.name = new_headline;
          if (new_description) linkData.description = new_description;
          if (new_destination_url) linkData.link = new_destination_url;
          if (new_cta_type) linkData.call_to_action = { type: new_cta_type };
          spec.link_data = linkData;
        }
        body.object_story_spec = spec;
      }

      // Copy asset_feed_spec (DPA / carousel / multi-variant creatives)
      if (original.asset_feed_spec) {
        const feedSpec = JSON.parse(JSON.stringify(original.asset_feed_spec)) as Record<string, unknown>;

        // Strip internal adlabels Meta attaches to each asset — they're tied to the original creative
        // and cause errors when re-posted. Also deduplicate images by hash.
        function stripLabels(items: unknown[]): unknown[] {
          return items.map((item) => {
            if (typeof item === 'object' && item !== null) {
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const { adlabels, ...rest } = item as Record<string, unknown>;
              return rest;
            }
            return item;
          });
        }
        function deduplicateByKey(items: unknown[], key: string): unknown[] {
          const seen = new Set<unknown>();
          return items.filter((item) => {
            const val = (item as Record<string, unknown>)[key];
            if (seen.has(val)) return false;
            seen.add(val);
            return true;
          });
        }

        for (const field of ['bodies', 'titles', 'descriptions', 'link_urls', 'call_to_actions'] as const) {
          if (Array.isArray(feedSpec[field])) {
            feedSpec[field] = stripLabels(feedSpec[field] as unknown[]);
          }
        }
        // Images: strip labels AND deduplicate by hash (same hash can appear multiple times for different placements)
        if (Array.isArray(feedSpec.images)) {
          feedSpec.images = deduplicateByKey(stripLabels(feedSpec.images as unknown[]), 'hash');
        }
        // asset_customization_rules reference adlabel names to map assets to placements.
        // After stripping adlabels, these rules become invalid — remove them entirely.
        // (Meta will serve all assets to all placements, which is fine for most use cases.)
        delete feedSpec.asset_customization_rules;

        // Strip empty display_url fields which can cause validation issues
        if (Array.isArray(feedSpec.link_urls)) {
          feedSpec.link_urls = (feedSpec.link_urls as Array<Record<string, unknown>>).map((lu) => {
            const cleaned = { ...lu };
            if (cleaned.display_url === '') delete cleaned.display_url;
            return cleaned;
          });
        }

        // Apply text/CTA overrides
        if (new_primary_text) feedSpec.bodies = [{ text: new_primary_text }];
        if (new_headline) feedSpec.titles = [{ text: new_headline }];
        if (new_description) feedSpec.descriptions = [{ text: new_description }];
        if (new_cta_type) feedSpec.call_to_action_types = [new_cta_type];
        if (new_destination_url) feedSpec.link_urls = [{ website_url: new_destination_url }];

        // When copy is overridden, strip DPA/shop-specific fields that require catalog-linked CTAs.
        // onsite_destinations and shops_bundle tie the ad to a Meta Shop and expect unmodified
        // placement-mapped assets — changing bodies/titles causes "link field required" errors.
        if (new_primary_text || new_headline || new_description || new_cta_type || new_destination_url) {
          delete feedSpec.onsite_destinations;
          delete feedSpec.shops_bundle;
          delete feedSpec.reasons_to_shop;
          // Also remove optimization_type=PLACEMENT which is tied to the per-placement asset rules
          if (feedSpec.optimization_type === 'PLACEMENT') delete feedSpec.optimization_type;
          // Without onsite_destinations, Meta needs an explicit call_to_actions with a link value
          // (call_to_action_types alone only works when the link is implicit via the Meta Shop)
          const linkUrls = feedSpec.link_urls as Array<Record<string, unknown>> | undefined;
          const linkUrl = linkUrls?.[0]?.website_url as string | undefined;
          const ctaType = new_cta_type
            || (feedSpec.call_to_action_types as string[] | undefined)?.[0]
            || 'SHOP_NOW';
          if (linkUrl) {
            feedSpec.call_to_actions = [{ type: ctaType, value: { link: linkUrl } }];
          }
        }

        body.asset_feed_spec = feedSpec;

        body.asset_feed_spec = feedSpec;
      }

      if (original.object_type) body.object_type = original.object_type;
      if (original.instagram_actor_id) body.instagram_actor_id = original.instagram_actor_id;

      try {
        return success(await graphPost(`/${accountId}/adcreatives`, body));
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 400) {
          const isDevelopmentMode = err.message.includes('1885183') || err.message.includes('development mode');
          const isCatalogPermission = err.message.includes('catalog_management') || err.message.includes('2490433');
          const isLinkRequired = err.message.includes('2061015') || err.message.includes('link field is required');
          let note: string;
          if (isDevelopmentMode) {
            note = 'Your Meta app is in DEVELOPMENT mode, which blocks creating new ad creatives via API. ' +
              'To fix: go to developers.facebook.com → your App → switch to Live mode. ' +
              'ALTERNATIVE (works now): Use create_ad with the original creative_id=' + creative_id +
              ' — you can attach the same creative to multiple ad sets without copying.';
          } else if (isCatalogPermission) {
            note = 'Duplicating DPA/catalog creatives requires catalog_management permission on your Meta app. ' +
              'ALTERNATIVE: Use create_ad with creative_id=' + creative_id +
              ' directly — the same creative can be reused across multiple ad sets without copying.';
          } else if (isLinkRequired && original.asset_feed_spec) {
            note = 'Text overrides are not supported for DPA/catalog creatives (asset_feed_spec) — ' +
              'Meta\'s placement-based validation requires the original copy structure. ' +
              'Workaround: (1) Duplicate without text overrides to get a copy of the creative, ' +
              'then manually update the copy in Ads Manager; or (2) use create_ad with the original ' +
              'creative_id=' + creative_id + ' to reuse it across multiple ad sets as-is.';
          } else {
            note = 'ALTERNATIVE: Use create_ad with creative_id=' + creative_id +
              ' directly — the same creative can be reused across multiple ad sets without copying.';
          }
          throw new ApiError(`${err.message} | NOTE: ${note}`, 400);
        }
        throw err;
      }
    },
  },

  // ═══════════════════════════ BUDGET SCHEDULES ══════════════════════════
  {
    name: 'create_budget_schedule',
    description: 'Schedule a budget increase for a campaign during high-demand periods.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        budget_value: { type: 'number' }, budget_value_type: { type: 'string', description: 'ABSOLUTE or MULTIPLIER' },
        time_start: { type: 'number', description: 'Unix timestamp' }, time_end: { type: 'number' },
      },
      required: ['campaign_id', 'budget_value', 'budget_value_type', 'time_start', 'time_end'],
    },
    zodSchema: z.object({
      campaign_id: z.string().min(1), budget_value: z.number(),
      budget_value_type: z.enum(['ABSOLUTE', 'MULTIPLIER']),
      time_start: z.number(), time_end: z.number(),
    }),
    async handler(args) {
      const { campaign_id, ...rest } = this.zodSchema.parse(args);
      return success(await graphPost(`/${campaign_id}/budget_schedules`, rest));
    },
  },
];

// ── Build tool lookup map ──────────────────────────────────────────────
const toolMap = new Map<string, ToolDef>(tools.map((t) => [t.name, t]));

// ── MCP Server ─────────────────────────────────────────────────────────
const server = new Server(
  { name: 'meta-ads', version: '3.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name: toolName, arguments: rawArgs } = request.params;
  const args = rawArgs ?? {};

  const tool = toolMap.get(toolName);
  if (!tool) {
    const available = tools.map((t) => t.name).join(', ');
    return errorResult(`Unknown tool "${toolName}". Available: ${available}`);
  }

  try {
    log('info', `Calling tool: ${toolName}`, args);
    const result = await tool.handler(args);
    log('info', `Tool ${toolName} completed`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', `Tool ${toolName} failed`, { error: message });
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return errorResult(`Invalid arguments: ${issues}`);
    }
    if (err instanceof ApiError) return errorResult(`API error (${err.statusCode}): ${message}`);
    return errorResult(message);
  }
});

// ── Start ──────────────────────────────────────────────────────────────
log('info', 'Meta Ads MCP server v3.0.0 starting (direct Graph API mode)', { toolCount: tools.length });
const transport = new StdioServerTransport();
await server.connect(transport);
log('info', 'Meta Ads MCP server connected via stdio');
