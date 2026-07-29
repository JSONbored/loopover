// Released migrations that were ALREADY edited before the immutability guard existed (#9420 fallout).
//
// check-released-migrations-immutable.ts normally freezes a migration at the content of the first release
// that shipped it. These 35 files cannot use that baseline: each was edited at some point across the project's
// history -- mostly in the orb-v0.1.0 / orb-v0.4.0 era -- long before the rule was written down or enforced.
//
// They are RE-FROZEN here at their current content rather than exempted. Exempting them would leave 35
// permanent holes in a guard whose whole value is having none; re-baselining keeps every one of them under
// the rule from here on, and costs only this generated table. Verified when this landed: none of these drifts
// against the live fleet -- every edit predates the deployments that applied the file, so no running ORB
// recorded the older hash. That is what makes re-freezing safe rather than merely convenient.
//
// NOTE 0180_decision_ledger.sql is deliberately NOT here. It is the file the #9420 incident actually broke,
// and it was repaired by restoring its original bytes -- so its first-release baseline is correct and it
// stays under the normal rule.
//
// DO NOT ADD ENTRIES. A new entry means someone edited a released migration and papered over it, which is
// precisely the boot failure this guard exists to prevent. Add a new migrations/NNNN_*.sql instead, and put
// prose in the source module that reads the table (see src/review/decision-record.ts's header).
export const MIGRATION_REBASELINE: ReadonlyMap<string, string> = new Map([
  ["0029_ai_review_provider_model.sql", "e7533a461476ea7fecebc33cc6a7889295add479"],
  ["0034_slop_ai_advisory.sql", "ab23e28623a484c93f045bc752407fbab2044e98"],
  ["0035_pull_request_slop_assessment.sql", "56d78b31ff660e3a99c92208fbd5d9ac94fb53da"],
  ["0042_agent_autonomy.sql", "85c28edacc98c92cc625c6371f5a29327577ca58"],
  ["0047_self_improve_tunables.sql", "af6347526cff858922f7adfa1c32141cfb0a954b"],
  ["0049_review_audit_parity.sql", "ebdcbcc7b65dd4fb25d96c5792d790330ef358b6"],
  ["0050_review_targets.sql", "4f75b205186fd7818d29eb7a11a97b3e995d303e"],
  ["0051_repo_chunks.sql", "7e1405a4742ccc3380ea12e70b6f9ad53ec63006"],
  ["0052_pr_merge_attempt_terminal.sql", "7dc06935c33848233c15ade0a9df0cebef379630"],
  ["0056_orb_events.sql", "daec50cef4efe09fa810f771963dd5d78a9cf94c"],
  ["0057_orb_installations.sql", "e7c96f4500ff3e0f1bdd7811db11c682ae13f263"],
  ["0058_orb_signals.sql", "796cd598d416adeebd8e3f5c4f0b8b48247b6424"],
  ["0060_orb_fleet_collector.sql", "47a4d7756a5bbd8ab68490a9d2262004f1982d45"],
  ["0061_orb_instances.sql", "151081374a2f7e1bb4f8e97e2978c06f7ea1f9ff"],
  ["0062_pr_last_regated_at.sql", "d3bd6140263884b61aed73d144fc2179bef74c90"],
  ["0064_orb_webhook_events.sql", "b8e60650f6986c0b67bd10543785c771c0e3be31"],
  ["0065_orb_github_installations.sql", "1607d818eca85ce8ec561f6d8504ef15c8d5aad7"],
  ["0067_orb_pr_outcomes.sql", "89eee98d18e50cce3dd1b874f0a12fc92fb406aa"],
  ["0068_orb_enrollments.sql", "976aea26f676c9fcbe876a9389e7ee45db9bf46f"],
  ["0071_installations_app_id.sql", "698697c7609dfea8ff42aadca2341705d4fbf9a8"],
  ["0072_contributor_blacklist.sql", "626b6580274e8633f4bf3e7bf9cea1929128aef2"],
  ["0080_pr_last_published_surface_sha.sql", "4fcca720632b83fbfdb6c9a57f1db156103d11c6"],
  ["0091_review_nag_cooldown.sql", "924cde088aff88d0fe2b0d2bf93a3c510ecc1f82"],
  ["0097_command_rate_limit.sql", "284cc6fffd0c3d079d43ea3cd5b2149fa4da5396"],
  ["0100_review_nag_monitored_mentions.sql", "793664ddeb6c859fbafae573cf1a89ff20c55283"],
  ["0102_fix_linked_issue_gate_mode_default.sql", "893273a3e6afba06f65bdf185e09a93cfc8566cc"],
  ["0113_review_evasion_protection.sql", "61e5a23fcc1e377cb0bd2b01e5a31300cf1e43f9"],
  ["0116_regate_sweep_order_mode.sql", "f5824a872f616d2d990d5ff2a4b8896cdbab1644"],
  ["0119_ai_slop_cache.sql", "3fe8ad831ae0754c9a441998912d603e482707af"],
  ["0126_contributor_gate_history.sql", "d8c7714ed65ae0845fcdb62bb68a3c06d4fb9f5f"],
  ["0127_agent_global_freeze_override.sql", "78169578f5b45a0e2dd225781b562ca325ac404a"],
  ["0134_pr_last_backlog_convergence_regated_at.sql", "ea71b7236b303a6b21cac8b0684adc969f629d13"],
  ["0137_predicted_gate_calls.sql", "5a35dfc8ae2ceb8711a639daf59f2a59d87ffe67"],
  ["0140_ai_review_low_confidence_disposition.sql", "bbe9077f0244d2d850aa392594272781e34860bd"],
  ["0143_repository_skip_automation_bot_authors.sql", "36c139f3be5b48c43d40506080e1d536750d408c"],
]);
