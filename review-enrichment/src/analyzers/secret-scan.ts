// Secret-scan analyzer (#1476). Scans the ADDED lines of the PR diff for credential patterns and high-entropy
// assignments, citing file:line and the KIND only — the matched secret VALUE is never returned (so the brief is
// safe to splice into a public review). Higher-recall than the engine's in-process regex pass, and line-cited via
// the hunk headers so the reviewer can point at the exact line.
import type { AddedLine } from "../analysis-context.js";
import type { EnrichRequest, SecretFinding } from "../types.js";

interface Rule {
  kind: string;
  re: RegExp;
  confidence: "high" | "medium";
}

// Ordered specific → generic. The generic assignment rule is medium-confidence (it catches real keys but also the
// occasional long opaque non-secret), so the reviewer treats it as "verify" rather than "block".
const RULES: Rule[] = [
  { kind: "aws_access_key_id", re: /\bAKIA[0-9A-Z]{16}\b/, confidence: "high" },
  {
    kind: "github_token",
    re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
    confidence: "high",
  },
  {
    // GitHub fine-grained personal access token (GitHub's recommended default): `github_pat_` + 82
    // base62/underscore chars. The classic `gh[pousr]_` rule above never matches this prefix.
    kind: "github_pat",
    re: /\bgithub_pat_[0-9A-Za-z_]{82}\b/,
    confidence: "high",
  },
  {
    // Slack tokens: bot/user/app/refresh/session (`baprs`) plus enterprise (`e`) and cookie (`c`).
    kind: "slack_token",
    re: /\bxox[baprsec]-[A-Za-z0-9-]{10,}\b/,
    confidence: "high",
  },
  {
    kind: "google_api_key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
    confidence: "high",
  },
  {
    // GitLab personal/project/group access token: `glpat-` + 20 base64url chars.
    kind: "gitlab_token",
    re: /\bglpat-[0-9A-Za-z_-]{20}(?![0-9A-Za-z_-])/,
    confidence: "high",
  },
  {
    // npm automation/publish token: `npm_` + 36 base62 chars.
    kind: "npm_token",
    re: /\bnpm_[A-Za-z0-9]{36}\b/,
    confidence: "high",
  },
  {
    // Stripe secret / restricted key: `sk_`/`rk_` + `live` or `test` + >=24 base62.
    // Test-mode keys (`sk_test_` / `rk_test_`) are still credentials and must not be committed.
    kind: "stripe_secret_key",
    re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{24,}\b/,
    confidence: "high",
  },
  {
    // SendGrid API key: `SG.` + 22-char id + `.` + 43-char secret (base64url).
    kind: "sendgrid_key",
    re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Hugging Face user access token: `hf_` + 34 base62 chars.
    kind: "huggingface_token",
    re: /\bhf_[A-Za-z0-9]{34}\b/,
    confidence: "high",
  },
  {
    // Anthropic API key: `sk-ant-` + base64url body. Distinct from Stripe `sk_live_` (underscore).
    // Negative-lookahead terminator (not `\b`) so a body ending in `-` still matches, like SendGrid.
    kind: "anthropic_api_key",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // OpenAI project-scoped API key: `sk-proj-` + base64url body. Distinct from Anthropic `sk-ant-`
    // and Stripe `sk_live_`/`sk_test_`. Negative-lookahead terminator for bodies ending in `-`/`_`.
    kind: "openai_project_key",
    re: /\bsk-proj-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // DigitalOcean personal access token: `dop_v1_` + 64 hex chars (case-insensitive).
    kind: "digitalocean_token",
    re: /\bdop_v1_[a-f0-9]{64}\b/i,
    confidence: "high",
  },
  {
    // Shopify Admin API access token (`shpat_`) or app shared secret (`shpss_`) + 32 hex chars.
    kind: "shopify_token",
    re: /\bshp(?:at|ss)_[a-f0-9]{32}\b/i,
    confidence: "high",
  },
  {
    // Postman API key: `PMAK-` + 24 hex + `-` + 34 hex.
    kind: "postman_api_key",
    re: /\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}\b/,
    confidence: "high",
  },
  {
    // Doppler personal token: `dp.pt.` + 43 base62.
    kind: "doppler_token",
    re: /\bdp\.pt\.[A-Za-z0-9]{43}\b/,
    confidence: "high",
  },
  {
    // Linear API key: `lin_api_` + 40 base62.
    kind: "linear_api_key",
    re: /\blin_api_[A-Za-z0-9]{40}\b/,
    confidence: "high",
  },
  {
    // New Relic user API key: `NRAK-` + 27 base62 (distinct from the NRJS-/NRII- license/ingest keys).
    kind: "newrelic_user_key",
    re: /\bNRAK-[A-Za-z0-9]{27}\b/,
    confidence: "high",
  },
  {
    // PyPI upload token: `pypi-` + the fixed `AgEIcHlwaS5vcmc` macaroon marker + base64url body. No
    // trailing \b — the base64url body may end in `-`/`_`.
    kind: "pypi_upload_token",
    re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/,
    confidence: "high",
  },
  {
    // Grafana service-account token: `glsa_` + 32 base62 + `_` + 8-hex checksum.
    kind: "grafana_service_account_token",
    re: /\bglsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}\b/,
    confidence: "high",
  },
  {
    // Dynatrace token: `dt0c01.` + 24 + `.` + 64, uppercase-alnum, three-part fixed shape.
    kind: "dynatrace_token",
    re: /\bdt0c01\.[A-Z0-9]{24}\.[A-Z0-9]{64}\b/,
    confidence: "high",
  },
  {
    // age (Filippo Valsorda) secret key: `AGE-SECRET-KEY-1` + 58 uppercase Bech32 chars.
    kind: "age_secret_key",
    re: /\bAGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}\b/,
    confidence: "high",
  },
  {
    // Clojars deploy token: `CLOJARS_` + 60 base62.
    kind: "clojars_token",
    re: /\bCLOJARS_[A-Za-z0-9]{60}\b/,
    confidence: "high",
  },
  {
    // Square access/OAuth token: `sq0` + 3-letter type + `-` + 22-43 base64url. Lookahead terminator
    // since the body can end in `-`/`_`.
    kind: "square_token",
    re: /\bsq0[a-z]{3}-[A-Za-z0-9_-]{22,43}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Notion internal integration secret: `secret_` + 43 base62 chars (50 chars total).
    kind: "notion_integration_secret",
    re: /\bsecret_[A-Za-z0-9]{43}\b/,
    confidence: "high",
  },
  {
    // Mailgun private API key: `key-` + 32 alphanumeric chars.
    kind: "mailgun_api_key",
    re: /\bkey-[0-9A-Za-z]{32}\b/,
    confidence: "high",
  },
  {
    // Discord bot token: `[MNO]` + 23 base64url chars, `.`, 6-char segment, `.`, 27-char segment.
    kind: "discord_bot_token",
    re: /\b[MNO][A-Za-z0-9_-]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Twilio Account SID: `AC` + 32 hex chars (distinct from Auth Token, which has no prefix).
    kind: "twilio_account_sid",
    re: /\bAC[0-9a-fA-F]{32}(?![A-Za-z0-9_])/,
    confidence: "high",
  },
  {
    // Twilio API Key SID: `SK` + 32 hex chars.
    kind: "twilio_api_key_sid",
    re: /\bSK[0-9a-fA-F]{32}(?![A-Za-z0-9_])/,
    confidence: "high",
  },
  {
    // Resend API key: `re_` + >=24 base62 chars.
    kind: "resend_api_key",
    re: /\bre_[A-Za-z0-9]{24,}(?![A-Za-z0-9])/,
    confidence: "high",
  },
  {
    // Mapbox secret access token: `sk.eyJ` + base64url body (distinct from Stripe `sk_live_` / `sk_test_`).
    kind: "mapbox_secret_token",
    re: /\bsk\.eyJ[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Cohere API key: `co_` + 48 base62 chars.
    kind: "cohere_api_key",
    re: /\bco_[A-Za-z0-9]{48}(?![A-Za-z0-9_])/,
    confidence: "high",
  },
  {
    // Intercom access token: base64 `tok:` prefix (`dG9rOm`) + opaque body.
    kind: "intercom_access_token",
    re: /\bdG9rOm[A-Za-z0-9+/=]{30,}(?![A-Za-z0-9+/=])/,
    confidence: "high",
  },
  {
    // Together AI API key: `together_` + base62 body.
    kind: "together_api_key",
    re: /\btogether_[A-Za-z0-9]{16,}(?![A-Za-z0-9_])/,
    confidence: "high",
  },
  {
    // Fireworks AI API key: `fw_` (standard) or `fpk_` (Fire Pass) + base62 body.
    kind: "fireworks_api_key",
    re: /\b(?:fw|fpk)_[A-Za-z0-9]{20,}(?![A-Za-z0-9_])/,
    confidence: "high",
  },
  {
    // Pinecone API key: `pcsk_{5-6 char label}_{63 char secret}`.
    kind: "pinecone_api_key",
    re: /\bpcsk_[A-Za-z0-9]{5,6}_[A-Za-z0-9]{63}(?![A-Za-z0-9_])/,
    confidence: "high",
  },
  {
    // Tavily API key: `tvly-` + base62 body (alnum only; reject hyphen-continued identifiers).
    kind: "tavily_api_key",
    re: /\btvly-[A-Za-z0-9]{16,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Voyage AI API key: `pa-` (platform) or `al-` (MongoDB Atlas) + base62 body.
    kind: "voyage_api_key",
    re: /\b(?:pa|al)-[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Firecrawl API key: `fc-` + base62 body (alnum only; reject hyphen-continued identifiers).
    kind: "firecrawl_api_key",
    re: /\bfc-[A-Za-z0-9]{16,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Browserbase API key: `bb_` + base62 body (reject hyphen-continued identifiers).
    kind: "browserbase_api_key",
    re: /\bbb_[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Modal token ID/secret: `ak-` (ID) or `as-` (secret) + base62 body.
    kind: "modal_token",
    re: /\b(?:ak|as)-[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // fal.ai API key: `fal_sk_` + base62 body (reject hyphen-continued identifiers).
    kind: "fal_api_key",
    re: /\bfal_sk_[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Weights & Biases API key: `wandb_v1_` + 77 base62/underscore chars.
    kind: "wandb_api_key",
    re: /\bwandb_v1_[A-Za-z0-9_]{77}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // xAI API key: `xai-` + base62 body (reject hyphen-continued identifiers).
    kind: "xai_api_key",
    re: /\bxai-[A-Za-z0-9]{16,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Deepgram API key: `dg.` + base62 body (reject dot/hyphen-continued identifiers).
    kind: "deepgram_api_key",
    re: /\bdg\.[A-Za-z0-9]{20,}(?![A-Za-z0-9_.-])/,
    confidence: "high",
  },
  {
    // Cartesia API key: `sk_car_` or admin `sk_car_admin_` + base62 body.
    kind: "cartesia_api_key",
    re: /\bsk_car_(?:admin_)?[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Apify personal API token: `apify_api_` + base62 body.
    kind: "apify_api_token",
    re: /\bapify_api_[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Baseten federated API key: `sky_{prefix}.{secret}` (prefix is 9-16 chars after `sky_`).
    kind: "baseten_federated_api_key",
    re: /\bsky_[A-Za-z0-9]{9,16}\.[A-Za-z0-9+/=_-]{20,}(?![A-Za-z0-9+/=_.-])/,
    confidence: "high",
  },
  {
    // Laminar project API key: `lmnr_` + base62 body.
    kind: "laminar_api_key",
    re: /\blmnr_[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Exa search API key: `exa_` + base62 body.
    kind: "exa_api_key",
    re: /\bexa_[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Mem0 API key: platform `m0-` or self-hosted `m0sk_` + body.
    kind: "mem0_api_key",
    re: /\bm0(?:sk_|-)[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_.-])/,
    confidence: "high",
  },
  {
    // Braintrust service token: `bt-st-` + base62 body.
    kind: "braintrust_service_token",
    re: /\bbt-st-[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // ScrapeGraphAI API key: `sgai-` + UUID-shaped body.
    kind: "scrapegraphai_api_key",
    re: /\bsgai-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F-])/,
    confidence: "high",
  },
  {
    // Langfuse public API key: `pk-lf-` + UUID-shaped body (pairs with `sk-lf-` secret key).
    kind: "langfuse_public_key",
    re: /\bpk-lf-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_.-])/,
    confidence: "high",
  },
  {
    // Hyperbolic API key: `hb_` + base62 body.
    kind: "hyperbolic_api_key",
    re: /\bhb_[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Gladia API key: `gla_` + base62 body.
    kind: "gladia_api_key",
    re: /\bgla_[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // WorkOS legacy API key: `wos_api_key_` + base62 body.
    kind: "workos_legacy_api_key",
    re: /\bwos_api_key_[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // MiniMax Token Plan subscription key: `sk-cp-` + base62 body (distinct from OpenAI `sk-proj-`/`sk-ant-`).
    kind: "minimax_token_plan_key",
    re: /\bsk-cp-[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // MiniMax pay-per-token API key: `sk-api-` + base62 body.
    kind: "minimax_pay_per_token_key",
    re: /\bsk-api-[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Google OAuth 2.0 client secret: `GOCSPX-` + 28 base64url chars.
    kind: "google_oauth_client_secret",
    re: /\bGOCSPX-[A-Za-z0-9_-]{28}\b/,
    confidence: "high",
  },
  {
    // Stripe webhook signing secret: `whsec_` + >=32 base62.
    kind: "stripe_webhook_secret",
    re: /\bwhsec_[A-Za-z0-9]{32,}\b/,
    confidence: "high",
  },
  {
    // Databricks personal access token: `dapi` + 32 hex.
    kind: "databricks_pat",
    re: /\bdapi[0-9a-f]{32}\b/,
    confidence: "high",
  },
  {
    // Telegram bot token: an 8-10 digit bot id, `:`, then 35 base64url chars.
    kind: "telegram_bot_token",
    re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
    confidence: "high",
  },
  {
    // RubyGems API key: `rubygems_` + 48 hex.
    kind: "rubygems_api_key",
    re: /\brubygems_[a-f0-9]{48}\b/,
    confidence: "high",
  },
  {
    // Terraform Cloud/Enterprise API token: 14 base62 + the `.atlasv1.` marker + >=60 base62/._- body.
    kind: "terraform_cloud_token",
    re: /\b[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9._-]{60,}/,
    confidence: "high",
  },
  {
    // PlanetScale database password: `pscale_pw_` + >=32 base62/._- (may end in `-`/`_`/`.`, so lookahead terminator).
    kind: "planetscale_password",
    re: /\bpscale_pw_[A-Za-z0-9._-]{32,}(?![A-Za-z0-9._-])/,
    confidence: "high",
  },
  {
    // PlanetScale service token: `pscale_tkn_` + >=32 base62/._- (lookahead terminator).
    kind: "planetscale_token",
    re: /\bpscale_tkn_[A-Za-z0-9._-]{32,}(?![A-Za-z0-9._-])/,
    confidence: "high",
  },
  {
    // Prefect Cloud API key: `pnu_` + 36 base62.
    kind: "prefect_api_key",
    re: /\bpnu_[A-Za-z0-9]{36}\b/,
    confidence: "high",
  },
  {
    // HashiCorp Vault service (`hvs.`) or batch (`hvb.`) token + >=24 base64url (lookahead terminator).
    kind: "vault_service_token",
    re: /\bhv[sb]\.[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Mailchimp API key: 32 hex + `-us` + a 1-2 digit datacenter suffix (the suffix disambiguates it from a bare hash).
    kind: "mailchimp_api_key",
    re: /\b[0-9a-f]{32}-us[0-9]{1,2}\b/,
    confidence: "high",
  },
  {
    // Slack incoming-webhook URL (hooks.slack.com/services/T…/B…/…): a postable message-egress secret endpoint.
    kind: "slack_webhook_url",
    re: /\bhttps:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]{8,}\/B[A-Za-z0-9_]{8,}\/[A-Za-z0-9_]{24}\b/,
    confidence: "high",
  },
  {
    // Airtable personal access token: `pat` + 14 base62 + `.` + 64 hex.
    kind: "airtable_pat",
    re: /\bpat[A-Za-z0-9]{14}\.[a-f0-9]{64}\b/,
    confidence: "high",
  },
  {
    // GitLab pipeline trigger token: `glptt-` + 40 hex.
    kind: "gitlab_pipeline_trigger_token",
    re: /\bglptt-[0-9a-f]{40}\b/,
    confidence: "high",
  },
  {
    // GitLab runner authentication token: `glrt-` + 20 base64url (distinct from the `glpat-` personal token above).
    kind: "gitlab_runner_token",
    re: /\bglrt-[0-9A-Za-z_-]{20}\b/,
    confidence: "high",
  },
  {
    // Shippo API token: `shippo_live_`/`shippo_test_` + 40 hex.
    kind: "shippo_api_token",
    re: /\bshippo_(?:live|test)_[a-f0-9]{40}\b/,
    confidence: "high",
  },
  {
    // Fly.io API token: `fo1_` + 43 base64url.
    kind: "flyio_token",
    re: /\bfo1_[A-Za-z0-9_-]{43}\b/,
    confidence: "high",
  },
  {
    // Dropbox short-lived access token: `sl.` + 130-152 base64url chars. A negative-lookahead terminator
    // (not `\b`) so a body ending in `-` still matches, like the SendGrid/Anthropic rules above.
    kind: "dropbox_token",
    re: /\bsl\.[A-Za-z0-9_-]{130,152}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // JFrog Artifactory API key: `AKCp8` + >=69 base62 (lookahead terminator — the body has no fixed end).
    kind: "jfrog_api_key",
    re: /\bAKCp8[A-Za-z0-9]{69,}(?![A-Za-z0-9])/,
    confidence: "high",
  },
  {
    // Duffel API token: `duffel_test_`/`duffel_live_` + 43 base64url (lookahead terminator — the body may end in `-`).
    kind: "duffel_token",
    re: /\bduffel_(?:test|live)_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // EasyPost API key: `EZAK` (production) / `EZTK` (test) + 54 base62.
    kind: "easypost_key",
    re: /\bEZ[AT]K[A-Za-z0-9]{54}\b/,
    confidence: "high",
  },
  {
    // Frame.io developer token: `fio-u-` + 64 base64url (lookahead terminator — the body may end in `-`).
    kind: "frameio_token",
    re: /\bfio-u-[A-Za-z0-9_-]{64}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Contentful personal access token: `CFPAT-` + 43 base64url (lookahead terminator — the body may end in `-`).
    kind: "contentful_token",
    re: /\bCFPAT-[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // SonarQube token: `sqa_`/`sqp_`/`squ_` (analysis/project/user) + 40 hex.
    kind: "sonarqube_token",
    re: /\bsq[apu]_[a-f0-9]{40}\b/,
    confidence: "high",
  },
  {
    // Pulumi access token: `pul-` + 40 hex.
    kind: "pulumi_token",
    re: /\bpul-[a-f0-9]{40}\b/,
    confidence: "high",
  },
  {
    // Adafruit IO key: `aio_` + 28 base62.
    kind: "adafruit_io_key",
    re: /\baio_[A-Za-z0-9]{28}\b/,
    confidence: "high",
  },
  {
    // ReadMe API key: `rdme_` + >=70 lowercase-hex-ish body (lookahead terminator).
    kind: "readme_api_key",
    re: /\brdme_[a-z0-9]{70,}(?![a-z0-9])/,
    confidence: "high",
  },
  {
    // Typeform personal access token: `tfp_` + >=40 base62/._- (lookahead terminator).
    kind: "typeform_token",
    re: /\btfp_[A-Za-z0-9._-]{40,}(?![A-Za-z0-9._-])/,
    confidence: "high",
  },
  {
    // Sentry DSN: an ingest URL embedding a 32-hex public key against a *.sentry.io host + project id.
    kind: "sentry_dsn",
    re: /\bhttps:\/\/[a-f0-9]{32}@[a-z0-9.-]*sentry\.io\/[0-9]+\b/,
    confidence: "high",
  },
  {
    // Groq API key: `gsk_` + 52 base62.
    kind: "groq_api_key",
    re: /\bgsk_[A-Za-z0-9]{52}\b/,
    confidence: "high",
  },
  {
    // Perplexity API key: `pplx-` + >=40 base62 (lookahead terminator).
    kind: "perplexity_api_key",
    re: /\bpplx-[A-Za-z0-9]{40,}(?![A-Za-z0-9])/,
    confidence: "high",
  },
  {
    // Discord webhook URL: discord.com/api/webhooks/<id>/<token>. Base64url token, lookahead terminator.
    kind: "discord_webhook_url",
    re: /\bhttps:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]{60,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Microsoft Teams incoming-webhook URL (webhook.office.com): a postable message-egress secret endpoint.
    kind: "teams_webhook_url",
    re: /\bhttps:\/\/[a-z0-9-]+\.webhook\.office\.com\/webhookb2\/[A-Za-z0-9@-]+\/IncomingWebhook\/[A-Za-z0-9]+\/[A-Za-z0-9-]+/,
    confidence: "high",
  },
  {
    // Figma personal access token: `figd_` + >=40 base64url (lookahead terminator).
    kind: "figma_pat",
    re: /\bfigd_[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Docker Hub personal access token: `dckr_pat_` + 27 base64url (lookahead terminator).
    kind: "dockerhub_pat",
    re: /\bdckr_pat_[A-Za-z0-9_-]{27}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // GitLab feed token: `glft-` + 20 hex.
    kind: "gitlab_feed_token",
    re: /\bglft-[0-9a-f]{20}\b/,
    confidence: "high",
  },
  {
    // GitLab deploy token: `gldt-` + 20 base64url (lookahead terminator).
    kind: "gitlab_deploy_token",
    re: /\bgldt-[A-Za-z0-9_-]{20}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Razorpay key id/secret: `rzp_test_`/`rzp_live_` + 14 base62.
    kind: "razorpay_key",
    re: /\brzp_(?:test|live)_[A-Za-z0-9]{14}\b/,
    confidence: "high",
  },
  {
    // Supabase access token: `sbp_` + 40 hex.
    kind: "supabase_token",
    re: /\bsbp_[a-f0-9]{40}\b/,
    confidence: "high",
  },
  {
    // Cloudinary URL: `cloudinary://<api-key>:<api-secret>@<cloud>` — the secret is embedded in the URL.
    kind: "cloudinary_url",
    re: /\bcloudinary:\/\/\d{15}:[A-Za-z0-9_-]{20,}@[A-Za-z0-9_-]+/,
    confidence: "high",
  },
  {
    // Brevo (Sendinblue) API key: `xkeysib-` + 64 hex + `-` + 16 base62.
    kind: "brevo_api_key",
    re: /\bxkeysib-[a-f0-9]{64}-[A-Za-z0-9]{16}\b/,
    confidence: "high",
  },
  {
    // Buildkite agent token: `bkua_` + 40 lowercase-hex/base36.
    kind: "buildkite_token",
    re: /\bbkua_[a-z0-9]{40}\b/,
    confidence: "high",
  },
  {
    // NuGet API key: `oy2` + 43 lowercase base36.
    kind: "nuget_api_key",
    re: /\boy2[a-z0-9]{43}\b/,
    confidence: "high",
  },
  {
    // HubSpot private-app access token: `pat-na1-`/`pat-eu1-` + a UUID (distinct from the Airtable `pat<id>.` shape).
    kind: "hubspot_pat",
    re: /\bpat-(?:na|eu)1-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/,
    confidence: "high",
  },
  {
    // Atlassian (Jira/Confluence) API token: the fixed `ATATT3xFfGF0` marker + base64url body (lookahead terminator).
    kind: "atlassian_api_token",
    re: /\bATATT3xFfGF0[A-Za-z0-9_=-]{50,}(?![A-Za-z0-9_=-])/,
    confidence: "high",
  },
  {
    // Alibaba Cloud access key id: `LTAI` + 20 base62.
    kind: "alibaba_access_key",
    re: /\bLTAI[A-Za-z0-9]{20}\b/,
    confidence: "high",
  },
  {
    // LangSmith API key: `lsv2_pt_` + 32 hex + `_` + 10 hex.
    kind: "langsmith_api_key",
    re: /\blsv2_pt_[a-f0-9]{32}_[a-f0-9]{10}\b/,
    confidence: "high",
  },
  {
    // Plaid access token: `access-{sandbox,development,production}-` + a UUID.
    kind: "plaid_access_token",
    re: /\baccess-(?:sandbox|development|production)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/,
    confidence: "high",
  },
  {
    // LaunchDarkly SDK/mobile key: `sdk-`/`mob-` + a UUID.
    kind: "launchdarkly_key",
    re: /\b(?:sdk|mob)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/,
    confidence: "high",
  },
  {
    // Grafana Cloud access-policy token: `glc_` + >=32 base62 (distinct from the `glsa_` service-account token).
    kind: "grafana_cloud_token",
    re: /\bglc_[A-Za-z0-9]{32,}(?![A-Za-z0-9])/,
    confidence: "high",
  },
  {
    // dbt Cloud service token: `dbtc_` + >=30 base64url (lookahead terminator).
    kind: "dbt_cloud_token",
    re: /\bdbtc_[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // PostHog personal API key: `phx_` + >=32 base62.
    kind: "posthog_personal_key",
    re: /\bphx_[A-Za-z0-9]{32,}(?![A-Za-z0-9])/,
    confidence: "high",
  },
  {
    // Render API key: `rnd_` + >=24 base62.
    kind: "render_api_key",
    re: /\brnd_[A-Za-z0-9]{24,}(?![A-Za-z0-9])/,
    confidence: "high",
  },
  {
    // Jina AI API key: `jina_` + >=28 base62.
    kind: "jina_api_key",
    re: /\bjina_[A-Za-z0-9]{28,}(?![A-Za-z0-9])/,
    confidence: "high",
  },
  {
    // Sentry user auth token: `sntryu_` + 64 hex (distinct from the `sntrys_` org token / DSN).
    kind: "sentry_user_token",
    re: /\bsntryu_[a-f0-9]{64}\b/,
    confidence: "high",
  },
  {
    // Replicate API token: `r8_` + >=37 base62.
    kind: "replicate_token",
    re: /\br8_[A-Za-z0-9]{37,}(?![A-Za-z0-9])/,
    confidence: "high",
  },
  {
    // OpenRouter API key: `sk-or-v1-` + 64 hex (distinct prefix from the OpenAI/Anthropic `sk-` keys above).
    kind: "openrouter_key",
    re: /\bsk-or-v1-[a-f0-9]{64}\b/,
    confidence: "high",
  },
  {
    // Amazon MWS auth token: `amzn.mws.` + a UUID.
    kind: "amazon_mws_token",
    re: /\bamzn\.mws\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/,
    confidence: "high",
  },
  {
    // Tencent Cloud secret id: `AKID` + >=32 base62.
    kind: "tencent_secret_id",
    re: /\bAKID[A-Za-z0-9]{32,}(?![A-Za-z0-9])/,
    confidence: "high",
  },
  {
    // Ory personal access token: `ory_pat_` + >=32 base64url (lookahead terminator).
    kind: "ory_pat",
    re: /\bory_pat_[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Braintree production access token: `access_token$production$` + 16 base36 merchant id + `$` + 32 hex.
    kind: "braintree_token",
    re: /\baccess_token\$production\$[0-9a-z]{16}\$[0-9a-f]{32}\b/,
    confidence: "high",
  },
  {
    // MailerSend API token: `mlsn.` + 64 hex.
    kind: "mailersend_token",
    re: /\bmlsn\.[a-f0-9]{64}\b/,
    confidence: "high",
  },
  {
    // Ghost Admin API key: a 24-hex id, `:`, then a 64-hex secret.
    kind: "ghost_admin_key",
    re: /\b[0-9a-f]{24}:[0-9a-f]{64}\b/,
    confidence: "high",
  },
  {
    // Xata API key: `xau_` + >=40 base64url (lookahead terminator).
    kind: "xata_api_key",
    re: /\bxau_[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Deno Deploy access token: `ddp_` + >=40 base62.
    kind: "deno_deploy_token",
    re: /\bddp_[A-Za-z0-9]{40,}(?![A-Za-z0-9])/,
    confidence: "high",
  },
  {
    // 1Password service-account token: `ops_` + a base64url body that begins with the `eyJ` JSON marker.
    kind: "onepassword_service_token",
    re: /\bops_eyJ[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // RunPod API key: `rpa_` + >=32 uppercase base36.
    kind: "runpod_api_key",
    re: /\brpa_[A-Z0-9]{32,}(?![A-Z0-9])/,
    confidence: "high",
  },
  {
    // New Relic insights insert key: `NRII-` + 32 base64url.
    kind: "newrelic_insights_key",
    re: /\bNRII-[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // New Relic REST API key: `NRRA-` + 42 hex.
    kind: "newrelic_rest_key",
    re: /\bNRRA-[a-f0-9]{42}\b/,
    confidence: "high",
  },
  {
    // Sentry organization auth token: `sntrys_` + base64url body (distinct from the `sntryu_` user token above).
    kind: "sentry_org_token",
    re: /\bsntrys_[A-Za-z0-9_=-]{40,}(?![A-Za-z0-9_=-])/,
    confidence: "high",
  },
  {
    // OpenAI service-account key: `sk-svcacct-` + base64url body (distinct from the `sk-proj-`/`sk-ant-` keys).
    kind: "openai_service_account_key",
    re: /\bsk-svcacct-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Google OAuth 2.0 access token: `ya29.` + base64url body.
    kind: "google_oauth_access_token",
    re: /\bya29\.[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Persona API key: `persona_sandbox_`/`persona_production_` + >=24 base62.
    kind: "persona_api_key",
    re: /\bpersona_(?:sandbox|production)_[A-Za-z0-9]{24,}(?![A-Za-z0-9])/,
    confidence: "high",
  },
  {
    // Depot API token: `depot_project_`/`depot_org_`/`depot_user_` + >=20 base62.
    kind: "depot_token",
    re: /\bdepot_(?:project|org|user)_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/,
    confidence: "high",
  },
  {
    // Octopus Deploy API key: `API-` + 26 uppercase base36.
    kind: "octopus_deploy_key",
    re: /\bAPI-[A-Z0-9]{26}\b/,
    confidence: "high",
  },
  {
    // Inngest signing key: `signkey-prod-`/`signkey-test-` + 64 hex.
    kind: "inngest_signing_key",
    re: /\bsignkey-(?:prod|test)-[a-f0-9]{64}\b/,
    confidence: "high",
  },
  {
    // Trigger.dev API key: `tr_prod_`/`tr_dev_` + >=20 base62 (word-char body → `\b` terminator).
    kind: "trigger_dev_key",
    re: /\btr_(?:prod|dev)_[A-Za-z0-9]{20,}\b/,
    confidence: "high",
  },
  {
    // Cal.com API key: `cal_live_`/`cal_test_` + >=20 hex (word-char body → `\b` terminator).
    kind: "cal_com_api_key",
    re: /\bcal_(?:live|test)_[a-f0-9]{20,}\b/,
    confidence: "high",
  },
  {
    // Cerebras API key: `csk-` + >=40 base62 (word-char body → `\b` terminator).
    kind: "cerebras_api_key",
    re: /\bcsk-[A-Za-z0-9]{40,}\b/,
    confidence: "high",
  },
  {
    // Helicone API key: `sk-helicone-` + a UUID-shaped body (distinct from the OpenAI/Anthropic `sk-` keys).
    // Body can end in `-`, so a negative-lookahead terminator (not `\b`), matching the SendGrid/Anthropic rules.
    kind: "helicone_api_key",
    re: /\bsk-helicone-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Langfuse secret key: `sk-lf-` + a UUID-shaped body (lookahead terminator, as above).
    kind: "langfuse_secret_key",
    re: /\bsk-lf-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Neon API key: `napi_` + >=40 base62 (word-char body → `\b` terminator).
    kind: "neon_api_key",
    re: /\bnapi_[A-Za-z0-9]{40,}\b/,
    confidence: "high",
  },
  {
    kind: "private_key",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
    confidence: "high",
  },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    confidence: "medium",
  },
  {
    kind: "generic_secret_assignment",
    re: /(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["'][A-Za-z0-9+/=_-]{16,}["']/i,
    confidence: "medium",
  },
];

/** Extract the inner text of every quoted string literal (single/double/backtick) on a line. Used to catch a
 *  secret whose literal value is split across two adjacent added lines and joined at runtime (e.g.
 *  `const a = "AKIA..."; const b = a + "REST";`) — pure per-line regex matching never sees the runtime-joined
 *  value, only the two separate source literals either side of the `+`. */
function extractStringLiteralContents(line: string): string[] {
  const literals: string[] = [];
  const re = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) literals.push(match[0].slice(1, -1));
  return literals;
}

/** Scan one file's unified-diff patch, tracking new-file line numbers via hunk headers. Pure. Value never captured. */
export function scanPatch(path: string, patch: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let newLine = 0;
  let inHunk = false;
  // Last added line's extracted string-literal contents, for the cross-line join check below. Reset whenever a
  // non-added line breaks the run — a secret is only plausibly split across CONSECUTIVE added lines.
  let previousLiterals: string[] = [];
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      previousLiterals = [];
      continue;
    }
    // Skip the pre-hunk preamble (diff/index + the `+++ `/`--- ` file headers). INSIDE a hunk the first char is
    // the +/-/space op, so an added line whose content starts with `++` (rendered `+++x` or `+++ x`) is scanned,
    // not mistaken for a header.
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      const content = line.slice(1);
      let matched = false;
      for (const rule of RULES) {
        if (rule.re.test(content)) {
          findings.push({ file: path, line: newLine, kind: rule.kind, confidence: rule.confidence });
          matched = true;
          break; // one finding per line — first (most specific) rule wins
        }
      }
      const currentLiterals = extractStringLiteralContents(content);
      // Bounded: only the immediately-preceding line's LAST literal joined with this line's FIRST literal — the
      // common "two sequential variable assignments" shape. Skipped once this line already matched on its own.
      const lastPrevious = previousLiterals.at(-1);
      const firstCurrent = currentLiterals[0];
      if (!matched && lastPrevious !== undefined && firstCurrent !== undefined) {
        const joined = lastPrevious + firstCurrent;
        for (const rule of RULES) {
          if (rule.re.test(joined)) {
            // "medium" regardless of the rule's own confidence — a joined pair is a heuristic, not a direct match.
            findings.push({ file: path, line: newLine, kind: rule.kind, confidence: "medium" });
            break;
          }
        }
      }
      previousLiterals = currentLiterals;
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      // Context line advances the new-file counter; removed lines and `\ No newline at end of
      // file` markers do not (same class as the iac-misconfig / redos / secret-log fix).
      newLine++;
      previousLiterals = [];
    } else {
      previousLiterals = [];
    }
  }
  return findings;
}

export function scanAddedLinesForSecrets(
  addedLines: readonly AddedLine[],
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const line of addedLines) {
    for (const rule of RULES) {
      if (rule.re.test(line.text)) {
        findings.push({
          file: line.file,
          line: line.line,
          kind: rule.kind,
          confidence: rule.confidence,
        });
        break;
      }
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed file's patch for leaked credentials. */
export async function scanSecrets(
  req: EnrichRequest,
): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];
  for (const file of req.files ?? []) {
    if (file.patch) findings.push(...scanPatch(file.path, file.patch));
  }
  return findings;
}
