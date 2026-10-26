import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// quantess's own settings never come from a project's .env (security review 10-24): a hostile repo could otherwise
// move QUANTESS_HOME (and with it the T-LINK key and origin), raise the daily cap, or pre-approve paid clicks
const OWN_SETTING = /^(?:QUANTESS_|Q23_)/i;
// The keys a project's .env supplied (never one already set): src/provider.js will not let such an OPENROUTER_API_KEY
// take a signed-in user off their plan (security review of 4d1cc19)
export const PROJECT_ENV_KEYS = new Set();

/**
 * The .env in dir, for ordinary keys only (an API key, say), and never over a variable that is already set.
 * @returns {string[]} the quantess settings it refused
 */
export function loadProjectEnv(dir = process.cwd(), env = process.env) {
  let parsed;
  try {
    parsed = dotenv.parse(fs.readFileSync(path.resolve(dir, '.env')));
  } catch {
    return [];
  }
  const refused = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (OWN_SETTING.test(key)) refused.push(key.toUpperCase());
    else if (env[key] === undefined) {
      env[key] = value;
      // Upper-cased: Windows variables ignore case, so openrouter_api_key in a .env IS OPENROUTER_API_KEY there
      PROJECT_ENV_KEYS.add(key.toUpperCase());
    }
  }
  return refused;
}

loadProjectEnv();

export const config = {
  openRouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    baseUrl: 'https://openrouter.ai/api/v1',
    // Optional: referer for OpenRouter rankings
    // referer: 'https://github.com/your-repo/q23-agent'
  },
  agent: {
    // 10-23: Nemotron Lightning and Super-VL. Paid Nemotron first (fast, cheap, no free queue),
    // free models as the fallback and the only lane once the day's cap is spent (src/budget.js).
    // QUANTESS_MODEL overrides the first model for a run.
    defaultModel: process.env.QUANTESS_MODEL || 'nvidia/nemotron-3.5-lightning',
    // Tried in order when the current model errors
    fallbackModels: [
      'nvidia/nemotron-3.5-super-vl',
      'cohere/north-mini-code:free',
      'dots-studio/dots-3-note-preview:free',
      'nvidia/nemotron-3.5-lightning:free'
    ],
    // --deep: the big thinker (slower, ~$0.60/$2.40 per million tokens)
    deepModel: 'nvidia/nemotron-3-ultra-550b-a55b',
    // web_search: this model + OpenRouter's web plugin (~1 cent a search)
    searchModel: 'nvidia/nemotron-3.5-lightning',
    // USD per UTC day on models; QUANTESS_DAILY_CAP_USD overrides
    dailyCapUsd: 5,
    // Free models used once the cap is reached, if the chain itself has none
    freeNet: ['cohere/north-mini-code:free', 'nvidia/nemotron-3.5-lightning:free'],
    // Q23's eyes (look_at_image): paid Nemotron Super-VL first, then FREE models that read images (both
    // scored 5/5 on known game screenshots 10-15; gemma was rate-limited upstream that day).
    visionModels: [
      'nvidia/nemotron-3.5-super-vl',
      'dots-studio/dots-3-note-preview:free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'google/gemma-4-31b-it:free'
    ],
    // Temperature for completions
    temperature: 0.7,
    // Max tokens for completion. 2048 cut a new game module off mid write_file (broken JSON args);
    // the free chain allows 64k+ out.
    maxTokens: 8192,
    // Tool choice: 'auto', 'required', or 'none'
    toolChoice: 'auto',
    // Max iterations per agent run
    // Free models: steps cost $0. A takeover shift spends 4 on its start routine alone, and one game
    // change (read, test first, edit, test, build, look, commit) runs ~20-30. Out of steps = paused, not lost.
    maxIterations: 40,
    // Enable streaming output
    stream: false
  },
  // Cost tracking (approximate, based on OpenRouter pricing)
  // These are example rates per 1M tokens - update as needed
  costTracking: {
    enabled: true,
    // Model: { input: cost per 1M tokens, output: cost per 1M tokens }
    // USD per million tokens - only an ESTIMATE for when OpenRouter sends no usage.cost (src/budget.js books
    // the real figure). OpenRouter list prices 10-23.
    modelPricing: {
      'nvidia/nemotron-3.5-lightning': { input: 0.07, output: 0.20 },
      'nvidia/nemotron-3.5-super-vl': { input: 0.15, output: 0.50 },
      'nvidia/nemotron-3-ultra-550b-a55b': { input: 0.60, output: 2.40 },
      'cohere/north-mini-code:free': { input: 0, output: 0 },
      'dots-studio/dots-3-note-preview:free': { input: 0, output: 0 },
      'nvidia/nemotron-3.5-lightning:free': { input: 0, output: 0 },
      'openai/gpt-4o-mini': { input: 0.15, output: 0.60 },
      'anthropic/claude-3-haiku': { input: 0.25, output: 1.25 },
      'meta-llama/llama-3-8b-instruct': { input: 0.10, output: 0.20 },
      'mistralai/mistral-7b-instruct-v0.2': { input: 0.15, output: 0.20 }
    }
  },
  // Session settings
  session: {
    // Session markdown files: ~/.q23/sessions, or Q23_SESSION_DIR (see src/session/index.js)
    // Auto-save interval in seconds
    autosaveInterval: 30,
    // Max history length before compaction
    maxHistoryLength: 50
  }
};

// Helper to get pricing for a model
export function getModelPricing(model) {
  return config.costTracking.modelPricing[model] || { input: 0, output: 0 };
}