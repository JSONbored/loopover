ALTER TABLE product_usage_daily_rollups
  ADD COLUMN roles_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE product_usage_daily_rollups
  ADD COLUMN activation_by_role_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE product_usage_daily_rollups
  ADD COLUMN activation_by_surface_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE product_usage_daily_rollups
  ADD COLUMN retention_json TEXT NOT NULL DEFAULT '[]';
